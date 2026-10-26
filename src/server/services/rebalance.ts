import { z } from "zod";
import { lotFor, rebalance, tradingCostsSchema } from "@/lib/finance/rebalance";
import { listAssets } from "./assets";
import { loadFxHistory, loadPriceHistory } from "./prices";
import { getPortfolioSummary } from "./portfolio";
import { getTradingCosts } from "./settings";
import { loadUniverse, optimizePortfolio } from "./optimizer";
import { optimizeInput } from "../optimize-schema";

export const rebalanceInput = z.object({
  targets: z
    .record(z.string(), z.number().min(0).max(1))
    .optional()
    .describe("Target weights by symbol (decimal, share of holdings + cash − reserve). Omit to use optimize_portfolio's recommendation"),
  optimizer: optimizeInput.optional().describe("optimize_portfolio parameters used when targets are omitted"),
  objective: z.enum(["track", "after_cost", "min_cost", "min_turnover"]).default("track").describe("track = closest to target; after_cost = distance + cost; min_cost / min_turnover penalize trading more"),
  extraCash: z.number().min(0).default(0).describe("New money to invest (THB)"),
  cashReserve: z.number().min(0).default(0).describe("THB to keep in cash outside the targets"),
  noTradeBand: z.number().min(0).max(0.5).default(0).describe("Leave an asset alone when |weight − target| < band (decimal)"),
  maxTurnover: z.number().min(0).max(2).optional().describe("Max Σ|trades| ÷ total (decimal)"),
  allowSell: z.boolean().default(true),
  sellUnlisted: z.boolean().default(false).describe("Sell held assets that have no target (default: keep them)"),
  maxTradeValue: z.record(z.string(), z.number().positive()).optional().describe("Liquidity cap: max THB traded per symbol"),
  costs: tradingCostsSchema.partial().optional().describe("Override the cost model from Settings for this proposal"),
});
export type RebalanceParams = z.input<typeof rebalanceInput>;

/** Proposed trades only — never records transactions. */
export async function rebalancePortfolio(input: RebalanceParams) {
  const x = rebalanceInput.parse(input);
  const [snap, assets, prices, fx, savedCosts] = await Promise.all([getPortfolioSummary(), listAssets(), loadPriceHistory(), loadFxHistory(), getTradingCosts()]);
  const costs = tradingCostsSchema.parse({ ...savedCosts, ...(x.costs ?? {}) });
  const warnings: string[] = [];

  let targets = x.targets ? Object.fromEntries(Object.entries(x.targets).map(([k, v]) => [k.toUpperCase(), v])) : null;
  let targetSource: "custom" | "optimizer" = "custom";
  let optimizer: Awaited<ReturnType<typeof optimizePortfolio>> | null = null;
  if (!targets) {
    optimizer = await optimizePortfolio({ ...(x.optimizer ?? {}), extraCash: x.extraCash });
    if (!optimizer.ok) return { ok: false as const, reason: optimizer.reason ?? "optimizer ไม่มีผลลัพธ์", proposalOnly: true as const };
    targets = Object.fromEntries(optimizer.allocations.map((a) => [a.symbol.toUpperCase(), a.weight]));
    targetSource = "optimizer";
    warnings.push("เป้าหมายจาก optimizer คิดเป็นสัดส่วนของ (มูลค่าสินทรัพย์ + เงินสด + เงินเพิ่ม − เงินสำรอง); ส่วนปลอดความเสี่ยงคงเป็นเงินสด");
  }

  const unknown = Object.keys(targets).filter((s) => !assets.some((a) => a.symbol.toUpperCase() === s));
  if (unknown.length) warnings.push(`ไม่พบ ${unknown.join(", ")} ในรายการสินทรัพย์ — ไม่รวม`);
  const posById = new Map(snap.positions.map((p) => [p.assetId, p]));
  const lastFx = fx[fx.length - 1]?.[1] ?? null;
  const rows = assets
    .filter((a) => a.assetClass !== "cash" && (targets![a.symbol.toUpperCase()] != null || (posById.get(a.id)?.quantity ?? 0) > 0))
    .map((a) => {
      const p = posById.get(a.id);
      const series = prices.get(a.id);
      const last = series?.[series.length - 1];
      const fxRate = a.currency === "USD" ? (p?.fxRate ?? lastFx) : 1;
      const unit = p?.lastPrice ?? last?.[1] ?? null;
      const price = unit != null && fxRate != null ? unit * fxRate : null;
      const t = targets![a.symbol.toUpperCase()];
      let priceWarning: string | undefined;
      if (p && p.priceStatus !== "market") priceWarning = p.priceStatus === "stale" ? `ราคาเก่า ${p.priceAgeDays} วัน` : "ใช้ราคาจากรายการซื้อขาย (ไม่มีราคาตลาด)";
      if (a.currency === "USD" && fxRate == null) priceWarning = "ไม่มีอัตรา USDTHB";
      return {
        symbol: a.symbol,
        assetClass: a.assetClass,
        price,
        quantity: p?.quantity ?? 0,
        lot: lotFor(costs, a.assetClass, a.lotSize),
        target: t != null ? t : x.sellUnlisted ? 0 : null,
        maxTradeValue: x.maxTradeValue?.[a.symbol.toUpperCase()],
        priceWarning,
      };
    });

  // Tracking error uses the optimizer covariance when every targeted asset has enough history.
  let cov: number[][] | null = null;
  const u = await loadUniverse(x.optimizer?.lookbackDays, rows.map((r) => r.symbol)).catch(() => null);
  if (u?.ok) {
    const idx = rows.map((r) => u.assets.findIndex((a) => a.symbol === r.symbol));
    if (idx.every((i) => i >= 0)) {
      const m = x.optimizer?.covMethod === "ledoit_wolf" ? u.covShrunk : u.cov;
      cov = idx.map((i) => idx.map((j) => m[i][j]));
    }
  }
  if (!cov) warnings.push("บางสินทรัพย์มีประวัติราคาไม่พอ — วัดความห่างจากเป้าหมายเป็นผลต่างน้ำหนัก แทน tracking error");

  const r = rebalance({
    assets: rows,
    cash: snap.cashThb,
    extraCash: x.extraCash,
    cashReserve: x.cashReserve,
    costs,
    objective: x.objective,
    noTradeBand: x.noTradeBand,
    maxTurnover: x.maxTurnover,
    allowSell: x.allowSell,
    cov,
  });
  return {
    ...r,
    warnings: [...warnings, ...r.warnings],
    targetSource,
    costModel: costs,
    optimizer: optimizer?.ok ? { objective: optimizer.objective, returnMethod: optimizer.returnMethod, recommended: optimizer.recommended } : null,
    disclaimer: "ข้อเสนอเท่านั้น — ระบบไม่ได้บันทึกรายการซื้อขาย ตรวจราคา/ค่าธรรมเนียมจริงก่อนส่งคำสั่ง แล้วบันทึกเองเมื่อซื้อขายจริง",
  };
}
