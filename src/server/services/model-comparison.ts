/**
 * Portfolio model comparison on stored prices (read-only): the same universe, calendar, bounds and
 * cost model for every model. Data preparation is the backtest's own (`loadBacktestData`).
 */
import { z } from "zod";
import { benchmarkField } from "@/server/basis-schema";
import { priceBasisReport, resolveReturnBasis } from "@/lib/finance/price-basis";
import { getSettings } from "./settings";
import { blendNote } from "@/lib/finance/mu-estimate";
import {
  COMPARISON_MODELS,
  compareModels,
  type ModelComparisonResult,
} from "@/lib/finance/model-comparison";
import { lotFor, tradingCostsSchema } from "@/lib/finance/rebalance";
import { loadBacktestData } from "./backtest";
import { DEFAULT_RETURN_METHOD, riskFreeInput } from "../optimize-schema";

export const modelComparisonInput = z.object({
  symbols: z
    .array(z.string())
    .min(2)
    .max(30)
    .optional()
    .describe(
      "Universe (default: every non-cash asset with prices). The same set is used for every model",
    ),
  startDate: z
    .string()
    .optional()
    .describe(
      "First date of data (YYYY-MM-DD); default = when all chosen assets have prices",
    ),
  endDate: z.string().optional(),
  models: z
    .array(z.enum(COMPARISON_MODELS))
    .min(1)
    .optional()
    .describe("Default: all six"),
  splitPct: z
    .number()
    .min(50)
    .max(90)
    .default(70)
    .describe(
      "Train / test split: % of the calendar used to estimate the weights; the rest is the out-of-sample test",
    ),
  windowDays: z
    .number()
    .int()
    .min(30)
    .max(2000)
    .default(252)
    .describe("Walk-forward training window in price observations"),
  rebalance: z
    .enum(["monthly", "quarterly", "semiannual", "annual"])
    .default("quarterly"),
  rebalanceAnchor: z
    .enum(["calendar", "periods"])
    .default("calendar")
    .describe(
      "calendar = last trading day of each period; periods = every N observations (previous behaviour)",
    ),
  minWeight: z.number().min(0).max(1).default(0),
  maxWeight: z.number().min(0).max(1).default(1),
  returnMethod: z
    .enum(["historical", "capm", "blend", "shrinkage"])
    .default(DEFAULT_RETURN_METHOD)
    .describe(
      "μ estimate (used by max_sharpe and by the ex-ante numbers of every model)",
    ),
  covMethod: z.enum(["sample", "ledoit_wolf"]).default("ledoit_wolf"),
  returnBasis: z
    .enum(["price_return", "total_return"])
    .optional()
    .describe(
      "price_return = closes; total_return = adjusted closes per asset (returnBasisByAsset). Omit = Settings default",
    ),
  benchmark: benchmarkField,
  useCosts: z
    .boolean()
    .default(true)
    .describe(
      "Deduct the trading cost model from Settings in the out-of-sample tests",
    ),
  costs: tradingCostsSchema.partial().optional(),
  initialCapital: z.number().positive().default(1_000_000),
  cvarConfidence: z.number().min(0.8).max(0.995).default(0.95),
  riskFree: riskFreeInput,
  historyPolicy: z
    .enum(["common", "drop_short"])
    .default("common")
    .describe(
      "drop_short = drop the assets whose short history makes the common period too short (listed in excluded)",
    ),
});

export async function comparePortfolioModels(
  input: z.input<typeof modelComparisonInput>,
) {
  const x = modelComparisonInput.parse(input);
  if (x.minWeight > x.maxWeight)
    throw new Error("น้ำหนักขั้นต่ำมากกว่าน้ำหนักสูงสุด");
  // PRICE_BASIS_BENCHMARK_SPEC F4: request → Settings → price_return.
  const basisInfo = resolveReturnBasis(
    x.returnBasis,
    (await getSettings()).defaultReturnBasis,
    "price_return",
  );
  x.returnBasis = basisInfo.used;
  const d = await loadBacktestData({
    symbols: x.symbols,
    startDate: x.startDate,
    endDate: x.endDate,
    returnBasis: x.returnBasis,
    rebalance: x.rebalance,
    useCosts: x.useCosts,
    costs: x.costs,
    useLots: false,
    riskFree: x.riskFree,
    historyPolicy: x.historyPolicy,
    benchmark: x.benchmark,
  });
  if (d.symbols.length < 2)
    throw new Error(
      `ต้องมีอย่างน้อย 2 สินทรัพย์ที่มีราคาครบช่วง${d.excluded.length ? ` — ไม่รวม ${d.excluded.map((e) => `${e.symbol} (${e.reason})`).join(", ")}` : ""}`,
    );
  const r = compareModels({
    symbols: d.symbols,
    dates: d.dates,
    prices: d.px,
    benchmark:
      d.benchmark && d.bench.length
        ? {
            symbol: d.benchmark.symbol,
            series: d.bench,
            kind: d.benchmark.kind,
          }
        : null,
    rf: d.rf,
    erp: d.settings.equityRiskPremium / 100,
    bounds: { min: x.minWeight, max: x.maxWeight },
    covMethod: x.covMethod,
    returnMethod: x.returnMethod,
    muCap: d.settings.muCapPct != null ? d.settings.muCapPct / 100 : null,
    costs: d.costs,
    lots: Object.fromEntries(
      d.pool.map((a) => [a.symbol, lotFor(d.costs, a.assetClass, a.lotSize)]),
    ),
    useLots: false,
    initialCapital: x.initialCapital,
    splitFraction: x.splitPct / 100,
    window: x.windowDays,
    rebalanceEvery: d.every,
    rebalanceCalendar:
      x.rebalanceAnchor === "calendar" ? x.rebalance : undefined,
    cvarConfidence: x.cvarConfidence,
    models: x.models,
  });
  if (!r.ok) throw new Error(r.error);
  return {
    ...r,
    input: {
      ...x,
      rebalanceEveryObservations: d.every,
      observations: d.dates.length,
    },
    period: { from: d.dates[0], to: d.dates[d.dates.length - 1] },
    excluded: d.excluded,
    riskFreeRate: d.rf,
    riskFreeInfo: d.riskFreeInfo,
    returnBasisByAsset: d.returnBasisByAsset,
    benchmark: d.benchmark
      ? {
          symbol: d.benchmark.symbol,
          kind: d.benchmark.kind,
          basis: d.benchmark.basis,
          wanted: d.benchmark.wanted,
          source: d.benchmark.source,
          warning: d.benchmark.warning,
        }
      : null,
    priceBasis: priceBasisReport(basisInfo, d.basisFallback, d.basisExcluded),
    warnings: [
      ...d.dataWarnings,
      // P1-7: the walk-forward / split windows are short — say how much blend leans on CAPM.
      ...(x.returnMethod === "blend" ? [blendNote(x.windowDays / d.obsPerYear)].filter((n): n is string => !!n) : []),
      ...r.warnings,
    ],
    limitations: [
      "Survivorship bias: ใช้เฉพาะสินทรัพย์ที่อยู่ในแอปวันนี้ — ผลอาจดีกว่าความเป็นจริง",
      x.returnBasis === "total_return"
        ? "ผลตอบแทนรวมจากราคาปรับปันผลของผู้ให้ข้อมูล ไม่หักภาษีปันผล"
        : "ราคาปิดไม่รวมเงินปันผล — หุ้นปันผลสูงจะดูแย่กว่าผลตอบแทนรวมจริง",
      "ช่วงทดสอบเดียวไม่พอสรุปว่าโมเดลใดดีกว่าเสมอ — อันดับเปลี่ยนได้ตามช่วงเวลา จำนวนหุ้น และข้อจำกัดน้ำหนัก",
      "ซื้อขายที่ราคาปิดวันปรับพอร์ต ซื้อเศษหน่วยได้ (ไม่ปัด lot) · ไม่มี market impact นอกจาก slippage ที่ตั้งไว้",
      "ผลในอดีตไม่รับประกันผลในอนาคต · ไม่ใช่คำแนะนำการลงทุน",
    ],
  };
}

type Full = Awaited<ReturnType<typeof comparePortfolioModels>>;
const monthEnd = <T extends { date: string }>(rows: T[]) =>
  rows.filter(
    (v, i) =>
      i === rows.length - 1 ||
      rows[i + 1].date.slice(0, 7) !== v.date.slice(0, 7),
  );
const round = (
  rows: ModelComparisonResult["split"] extends infer S
    ? S extends { curve: infer C }
      ? C
      : never
    : never,
) =>
  monthEnd(rows).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        typeof v === "number" ? Math.round(v * 100) / 100 : v,
      ]),
    ),
  );

/** Compact result for AI tools: tables in full, curves at month ends. */
export function summarizeModelComparison(r: Full) {
  return {
    symbols: r.symbols,
    models: r.models,
    period: r.period,
    riskFreeRate: r.riskFreeRate,
    benchmark: r.benchmark,
    priceBasis: r.priceBasis,
    excluded: r.excluded,
    returnBasisByAsset: r.returnBasisByAsset,
    split: r.split && {
      train: r.split.train,
      test: r.split.test,
      ranking: r.split.ranking,
      results: r.split.results,
      wealthIndexMonthEnd: round(r.split.curve),
    },
    walkForward: r.walkForward && {
      window: r.walkForward.window,
      test: r.walkForward.test,
      ranking: r.walkForward.ranking,
      results: r.walkForward.results,
      wealthIndexMonthEnd: round(r.walkForward.curve),
    },
    warnings: r.warnings,
    methodology: r.methodology,
    limitations: r.limitations,
  };
}
