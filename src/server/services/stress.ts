import { z } from "zod";
import { PRESET_SCENARIOS, historicalWorst, runStress, type StressPosition } from "@/lib/finance/stress";
import { getPortfolioSummary } from "./portfolio";
import { loadUniverse } from "./optimizer";
import { bondHoldings } from "./bonds";

const scenario = z.object({
  name: z.string().optional(),
  equityShock: z.number().min(-1).max(1).optional().describe("Market return shock (decimal, −0.2 = −20%); each asset moves β × shock"),
  rateShock: z.number().min(-0.1).max(0.1).optional().describe("Parallel yield change (decimal, 0.01 = +100bp); bonds via modified duration and convexity"),
  fxShock: z.number().min(-0.9).max(1).optional().describe("Change in THB per USD (decimal, −0.1 = baht 10% stronger) for USD assets"),
  specific: z.record(z.string(), z.number().min(-1).max(5)).optional().describe("Company-specific shocks by symbol (decimal)"),
  groups: z.array(z.object({ name: z.string(), symbols: z.array(z.string()).min(1), shock: z.number().min(-1).max(5) })).max(20).optional().describe("Shock a user-defined group (e.g. a sector) — the app has no sector data"),
  liquidityHaircut: z.record(z.string(), z.number().min(0).max(0.9)).optional().describe("Forced-sale discount by asset class (decimal)"),
  durationOverride: z.record(z.string(), z.number().min(0).max(50)).optional().describe("Modified duration by symbol (e.g. bond funds)"),
  correlationShock: z.number().min(0).max(1).optional().describe("k in ρ' = ρ + k(1 − ρ)"),
});

export const stressInput = z.object({
  scenarios: z.array(scenario).max(10).optional().describe("Custom scenarios; omit to run the presets"),
  presets: z.array(z.enum(Object.keys(PRESET_SCENARIOS) as [string, ...string[]])).optional().describe(`Preset names: ${Object.keys(PRESET_SCENARIOS).join(", ")}`),
  lookbackDays: z.number().int().min(90).max(3650).optional().describe("History for β, covariance and the historical replay (default 2 years)"),
});

/** Stress test of the current holdings. Read-only. */
export async function stressTestPortfolio(input: z.input<typeof stressInput> = {}) {
  const x = stressInput.parse(input);
  const [snap, bonds] = await Promise.all([getPortfolioSummary(), bondHoldings()]);
  const held = snap.positions.filter((p) => p.quantity > 0 && p.assetClass !== "cash");
  const u = await loadUniverse(x.lookbackDays ?? 730, held.map((p) => p.symbol), { withSeries: true }).catch(() => null);
  const uAsset = (sym: string) => (u?.ok ? u.assets.find((a) => a.symbol === sym) : undefined);
  const bondOf = (sym: string) => bonds.bonds.find((b) => b.symbol === sym && b.analytics);
  const positions: StressPosition[] = held.map((p) => {
    const b = bondOf(p.symbol);
    return {
      symbol: p.symbol,
      assetClass: p.assetClass,
      currency: p.currency,
      value: p.marketValueThb,
      beta: uAsset(p.symbol)?.beta ?? null,
      modifiedDuration: b?.analytics?.modifiedDuration ?? null,
      convexity: b?.analytics?.convexity ?? null,
      durationSource: b ? `คำนวณจากราคา ${b.lastPrice} (${b.lastPriceDate})` : undefined,
    };
  });
  const cov = u?.ok ? { symbols: u.assets.map((a) => a.symbol), matrix: u.cov, periodsPerYear: u.periodsPerYear } : undefined;
  const list = x.scenarios?.length ? x.scenarios : (x.presets?.length ? x.presets : Object.keys(PRESET_SCENARIOS)).map((k) => PRESET_SCENARIOS[k]);
  const results = list.map((s) => runStress(positions, snap.cashThb, s, cov));

  let history = null;
  if (u?.ok && u.series) {
    const vals = u.assets.map((a) => held.find((p) => p.symbol === a.symbol)?.marketValueThb ?? 0);
    const tot = vals.reduce((a, b) => a + b, 0);
    if (tot > 0) history = { ...historicalWorst(u.series.returns, vals.map((v) => v / tot), u.series.dates), coverage: tot / Math.max(snap.totalValueThb, 1e-9), note: "ใช้น้ำหนักปัจจุบันกับผลตอบแทนจริงในอดีต (เฉพาะสินทรัพย์ที่มีประวัติราคาพอ ไม่รวมเงินสด)" };
  }
  return {
    asOf: new Date().toISOString().slice(0, 10),
    nav: snap.totalValueThb,
    cash: snap.cashThb,
    assumptions: {
      beta: u?.ok ? `β เทียบ ${u.benchmark} จากผลตอบแทน ${u.from} → ${u.to} (${u.observations} วัน)` : "ไม่มี β (ประวัติราคาไม่พอ)",
      duration: "Modified duration / convexity ของพันธบัตรจากราคาล่าสุด (หน้าพันธบัตร); กองทุนต้องใส่ durationOverride",
      fx: "สินทรัพย์ USD: (1 + ผลจากราคา)(1 + ΔFX) − 1",
      correlation: "ρ' = ρ + k(1 − ρ) ความผันผวนรายตัวคงเดิม · VaR 95% 1 วันแบบ parametric (normal)",
      presets: "ขนาด shock ใน preset เป็นตัวอย่าง แก้ได้",
    },
    results,
    history,
    skipped: u?.ok ? u.skipped : [],
  };
}
