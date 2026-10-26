import { asOf, buildSnapshot, type AssetInput, type TxInput } from "@/lib/finance/portfolio";
import { estimateInputs } from "@/lib/finance/mpt";
import { recommend, type Objective } from "@/lib/finance/recommend";
import { beta as calcBeta } from "@/lib/finance/risk";
import { simpleReturns, mean, TRADING_DAYS } from "@/lib/finance/stats";
import { today } from "@/lib/validation";
import type { AssetClass } from "@/db/schema";
import { listAssets } from "./assets";
import { loadBenchmark, loadFxHistory, loadPriceHistory } from "./prices";
import { getSettings } from "./settings";
import { allTransactions } from "./transactions";

const MIN_OBS = 60;

export interface UniverseAsset {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  held: boolean;
  currentValue: number;
  historicalReturn: number;
  volatility: number;
  beta: number | null;
  capmReturn: number | null;
}

export interface OptimizerUniverse {
  ok: boolean;
  reason?: string;
  from: string | null;
  to: string | null;
  observations: number;
  riskFree: number;
  equityRiskPremium: number;
  benchmark: string;
  assets: UniverseAsset[];
  skipped: { symbol: string; reason: string }[];
  /** Annualized covariance of daily THB returns, aligned with `assets`. */
  cov: number[][];
}

/**
 * Builds the investable universe: every asset (held or not) with enough price
 * history, its THB daily returns on a common forward-filled calendar,
 * historical and CAPM expected returns, and the covariance matrix.
 */
export async function loadUniverse(lookbackDays = 365 * 3, symbols?: string[]): Promise<OptimizerUniverse> {
  const [assets, txRows, prices, fx, settings] = await Promise.all([
    listAssets(),
    allTransactions(),
    loadPriceHistory(),
    loadFxHistory(),
    getSettings(),
  ]);
  const bench = await loadBenchmark(settings.benchmarkSymbol);
  const rf = settings.riskFreeRate / 100;
  const erp = settings.equityRiskPremium / 100;
  const from = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

  const txs: TxInput[] = txRows.map((t) => ({ ...t }));
  const assetInputs: AssetInput[] = assets.map((a) => ({ id: a.id, symbol: a.symbol, name: a.name, assetClass: a.assetClass, currency: a.currency }));
  const snap = buildSnapshot(assetInputs, txs, prices, fx, today());
  const valueOf = new Map(snap.positions.map((p) => [p.assetId, p.marketValueThb]));

  const wanted = symbols?.length ? new Set(symbols.map((s) => s.toUpperCase())) : null;
  const skipped: { symbol: string; reason: string }[] = [];
  const candidates = assets.filter((a) => a.assetClass !== "cash" && (!wanted || wanted.has(a.symbol.toUpperCase())));
  const fxStart = fx[0]?.[0];
  const usable = candidates.filter((a) => {
    const n = prices.get(a.id)?.filter(([d]) => d >= from).length ?? 0;
    if (n < MIN_OBS) {
      skipped.push({ symbol: a.symbol, reason: `มีราคาเพียง ${n} วัน (ต้องการ ≥ ${MIN_OBS})` });
      return false;
    }
    // Never convert at FX = 1: USD assets need USDTHB history covering the window.
    if (a.currency === "USD" && (fxStart == null || fxStart > (prices.get(a.id)!.find(([d]) => d >= from)?.[0] ?? from))) {
      skipped.push({ symbol: a.symbol, reason: "ไม่มีอัตรา USDTHB ครอบคลุมช่วงข้อมูล" });
      return false;
    }
    return true;
  });

  const empty: OptimizerUniverse = {
    ok: false,
    from: null,
    to: null,
    observations: 0,
    riskFree: rf,
    equityRiskPremium: erp,
    benchmark: settings.benchmarkSymbol,
    assets: [],
    skipped,
    cov: [],
  };
  if (usable.length < 2) return { ...empty, reason: "ต้องมีสินทรัพย์ที่มีประวัติราคาเพียงพออย่างน้อย 2 ตัว" };

  // Common calendar: union of price dates after every asset has started trading.
  const start = usable.reduce((m, a) => {
    const first = prices.get(a.id)!.find(([d]) => d >= from)![0];
    return first > m ? first : m;
  }, from);
  const cal = new Set<string>();
  for (const a of usable) for (const [d] of prices.get(a.id)!) if (d >= start) cal.add(d);
  const dates = [...cal].sort();
  if (dates.length < MIN_OBS) return { ...empty, reason: "ช่วงเวลาที่มีราคาซ้อนกันสั้นเกินไป" };

  const series = usable.map((a) =>
    simpleReturns(dates.map((d) => (asOf(prices.get(a.id), d) ?? 0) * (a.currency === "USD" ? (asOf(fx, d) ?? NaN) : 1))),
  );
  const benchReturns = bench.length ? simpleReturns(dates.map((d) => asOf(bench, d) ?? 0)) : null;
  const { cov } = estimateInputs(series);

  return {
    ok: true,
    from: dates[0],
    to: dates[dates.length - 1],
    observations: dates.length,
    riskFree: rf,
    equityRiskPremium: erp,
    benchmark: settings.benchmarkSymbol,
    skipped,
    cov,
    assets: usable.map((a, i) => {
      const b = benchReturns && benchReturns.every((x) => Number.isFinite(x)) ? calcBeta(series[i], benchReturns) : null;
      return {
        symbol: a.symbol,
        name: a.name,
        assetClass: a.assetClass,
        held: (valueOf.get(a.id) ?? 0) > 0,
        currentValue: valueOf.get(a.id) ?? 0,
        // Geometric annualization of the mean daily return.
        historicalReturn: (1 + mean(series[i])) ** TRADING_DAYS - 1,
        volatility: Math.sqrt(cov[i][i]),
        beta: b,
        capmReturn: b != null ? rf + b * erp : null,
      };
    }),
  };
}

export type ReturnMethod = "historical" | "capm" | "blend";

export function expectedReturns(u: OptimizerUniverse, method: ReturnMethod, overrides: Record<string, number> = {}) {
  return u.assets.map((a) => {
    const o = overrides[a.symbol];
    if (o != null) return o;
    const capm = a.capmReturn ?? a.historicalReturn;
    if (method === "capm") return capm;
    if (method === "blend") return 0.5 * a.historicalReturn + 0.5 * capm;
    return a.historicalReturn;
  });
}

export interface OptimizeParams {
  symbols?: string[];
  lookbackDays?: number;
  returnMethod?: ReturnMethod;
  /** Expected annual return overrides (decimal) by symbol. */
  overrides?: Record<string, number>;
  objective?: Objective;
  riskAversion?: number;
  targetReturn?: number;
  targetRisk?: number;
  minWeight?: number;
  maxWeight?: number;
  useRiskFree?: boolean;
  /** Additional THB to invest on top of current holdings. */
  extraCash?: number;
}

/** Server-side recommendation used by the AI advisor, MCP and REST. */
export async function optimizePortfolio(p: OptimizeParams) {
  const u = await loadUniverse(p.lookbackDays, p.symbols);
  if (!u.ok) return { ok: false as const, reason: u.reason, skipped: u.skipped };
  const mu = expectedReturns(u, p.returnMethod ?? "blend", p.overrides);
  const currentValues = u.assets.map((a) => a.currentValue);
  const r = recommend({
    symbols: u.assets.map((a) => a.symbol),
    mu,
    cov: u.cov,
    rf: u.riskFree,
    bounds: { min: p.minWeight ?? 0, max: p.maxWeight ?? 1 },
    objective: p.objective ?? "max_sharpe",
    riskAversion: p.riskAversion ?? 4,
    targetReturn: p.targetReturn,
    targetRisk: p.targetRisk,
    currentValues,
    totalWealth: currentValues.reduce((a, b) => a + b, 0) + (p.extraCash ?? 0),
    useRiskFree: p.useRiskFree ?? false,
  });
  return {
    ok: true as const,
    period: { from: u.from, to: u.to, observations: u.observations },
    riskFree: u.riskFree,
    returnMethod: p.returnMethod ?? "blend",
    assets: u.assets.map((a, i) => ({ symbol: a.symbol, assetClass: a.assetClass, expectedReturn: mu[i], volatility: a.volatility, beta: a.beta })),
    skipped: u.skipped,
    objective: r.objective,
    allocations: r.allocations,
    riskyShare: r.riskyShare,
    riskFreeShare: r.riskFreeShare,
    recommended: r.final,
    current: r.current && { expectedReturn: r.current.expectedReturn, volatility: r.current.volatility, sharpe: r.current.sharpe },
    minVariance: { expectedReturn: r.gmv.expectedReturn, volatility: r.gmv.volatility, sharpe: r.gmv.sharpe },
    maxSharpe: { expectedReturn: r.tangency.expectedReturn, volatility: r.tangency.volatility, sharpe: r.tangency.sharpe },
    notes: r.notes,
  };
}
