import { asOf, buildSnapshot, type AssetInput, type TxInput } from "@/lib/finance/portfolio";
import { covarianceDiagnostics, estimateInputs, ledoitWolf, type Matrix } from "@/lib/finance/mpt";
import { recommend, type Objective } from "@/lib/finance/recommend";
import { blackLitterman, type BlView } from "@/lib/finance/black-litterman";
import { OptimizerError } from "@/lib/finance/optimizer";
import { beta as calcBeta } from "@/lib/finance/risk";
import { simpleReturns, mean } from "@/lib/finance/stats";
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
  /** Annualized sample covariance of THB returns, aligned with `assets`. */
  cov: Matrix;
  /** Ledoit–Wolf shrinkage toward a scaled identity (annualized) and its intensity δ. */
  covShrunk: Matrix;
  shrinkage: number;
  /** Return observations per year implied by the data (not a fixed 252). */
  periodsPerYear: number;
  covarianceWarnings: string[];
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
    covShrunk: [],
    shrinkage: 0,
    periodsPerYear: 0,
    covarianceWarnings: [],
  };
  if (usable.length < 2) return { ...empty, reason: "ต้องมีสินทรัพย์ที่มีประวัติราคาเพียงพออย่างน้อย 2 ตัว" };

  // Common calendar: only dates on which every asset has an actual price (no forward-filled zero returns).
  const sets = usable.map((a) => new Set(prices.get(a.id)!.filter(([d]) => d >= from).map(([d]) => d)));
  const dates = [...sets[0]].filter((d) => sets.every((x) => x.has(d))).sort();
  if (dates.length < MIN_OBS) return { ...empty, reason: `วันที่ทุกสินทรัพย์มีราคาพร้อมกันมีเพียง ${dates.length} วัน (ต้องการ ≥ ${MIN_OBS})` };

  const series = usable.map((a) =>
    simpleReturns(dates.map((d) => (asOf(prices.get(a.id), d) ?? 0) * (a.currency === "USD" ? (asOf(fx, d) ?? NaN) : 1))),
  );
  // Observations per year from the data, so daily, weekly or fund-NAV calendars annualize consistently.
  const years = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / (365 * 86_400_000);
  const N = years > 0 ? (dates.length - 1) / years : 252;
  const benchReturns = bench.length ? simpleReturns(dates.map((d) => asOf(bench, d) ?? 0)) : null;
  const { cov } = estimateInputs(series, N);
  const lw = ledoitWolf(series);
  const covShrunk = lw.cov.map((r) => r.map((x) => x * N));
  const covarianceWarnings = covarianceDiagnostics(cov).warnings;

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
    covShrunk,
    shrinkage: lw.intensity,
    periodsPerYear: N,
    covarianceWarnings,
    assets: usable.map((a, i) => {
      const b = benchReturns && benchReturns.every((x) => Number.isFinite(x)) ? calcBeta(series[i], benchReturns) : null;
      return {
        symbol: a.symbol,
        name: a.name,
        assetClass: a.assetClass,
        held: (valueOf.get(a.id) ?? 0) > 0,
        currentValue: valueOf.get(a.id) ?? 0,
        // Arithmetic mean × N: the expected-return input consistent with an annualized covariance.
        historicalReturn: mean(series[i]) * N,
        volatility: Math.sqrt(cov[i][i]),
        beta: b,
        capmReturn: b != null ? rf + b * erp : null,
      };
    }),
  };
}

export type ReturnMethod = "historical" | "capm" | "blend" | "black_litterman";

export function expectedReturns(u: OptimizerUniverse, method: ReturnMethod, overrides: Record<string, number> = {}) {
  return u.assets.map((a) => {
    const o = overrides[a.symbol];
    if (o != null) return o;
    const capm = a.capmReturn ?? a.historicalReturn;
    if (method === "capm" || method === "black_litterman") return capm;
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
  covMethod?: "sample" | "ledoit_wolf";
  blackLitterman?: { marketWeights: Record<string, number>; marketRiskAversion?: number; tau?: number; views?: BlView[]; posteriorCovariance?: boolean };
}

/** Server-side recommendation used by the AI advisor, MCP and REST. */
export async function optimizePortfolio(p: OptimizeParams) {
  const u = await loadUniverse(p.lookbackDays, p.symbols);
  if (!u.ok) return { ok: false as const, reason: u.reason, skipped: u.skipped };
  const symbols = u.assets.map((a) => a.symbol);
  const baseCov = p.covMethod === "ledoit_wolf" ? u.covShrunk : u.cov;
  const method = p.returnMethod ?? "blend";
  let mu = expectedReturns(u, method, p.overrides);
  let cov = baseCov;
  const extraWarnings: string[] = [];
  let bl: ReturnType<typeof blackLittermanSummary> | null = null;
  if (method === "black_litterman") {
    if (!p.blackLitterman) throw new OptimizerError({ code: "INVALID_INPUT", message: "Black–Litterman ต้องระบุ marketWeights" });
    const b = blackLitterman({
      symbols,
      cov: baseCov,
      rf: u.riskFree,
      marketWeights: p.blackLitterman.marketWeights,
      riskAversion: p.blackLitterman.marketRiskAversion,
      marketPremium: u.equityRiskPremium,
      tau: p.blackLitterman.tau ?? 0.05,
      views: p.blackLitterman.views ?? [],
    });
    if (!b.ok) throw new OptimizerError({ code: "INVALID_INPUT", message: b.errors.join(" · ") });
    mu = b.posterior.map((m, i) => p.overrides?.[symbols[i]] ?? m);
    if (p.overrides && Object.keys(p.overrides).length) extraWarnings.push("ใช้ overrides แทน posterior ของสินทรัพย์ที่ระบุ");
    if (p.blackLitterman.posteriorCovariance) cov = b.posteriorCov!;
    extraWarnings.push(...b.warnings);
    bl = blackLittermanSummary(b, symbols);
  }
  const currentValues = u.assets.map((a) => a.currentValue);
  const constraints = {
    rf: u.riskFree,
    bounds: { min: p.minWeight ?? 0, max: p.maxWeight ?? 1 },
    objective: p.objective ?? "max_sharpe",
    riskAversion: p.riskAversion ?? 4,
    targetReturn: p.targetReturn,
    targetRisk: p.targetRisk,
    currentValues,
    totalWealth: currentValues.reduce((a, b) => a + b, 0) + (p.extraCash ?? 0),
    useRiskFree: p.useRiskFree ?? false,
  };
  const r = recommend({
    symbols,
    mu,
    cov,
    ...constraints,
  });
  // Same optimizer and constraints with the equilibrium prior, to compare recommended weights.
  if (bl) {
    const prior = recommend({ symbols, mu: bl.assets.map((a) => a.prior), cov: baseCov, ...constraints });
    bl.weights = symbols.map((s, i) => ({
      symbol: s,
      market: bl!.assets[i].marketWeight,
      priorOptimal: prior.ok ? prior.allocations[i].weight : null,
      posteriorOptimal: r.ok ? r.allocations[i].weight : null,
    }));
    if (!prior.ok) extraWarnings.push(`พอร์ตจาก prior คำนวณไม่ได้: ${prior.issue.message}`);
  }
  // Surfaces as REST 400 / MCP isError with the typed code; no weights are returned.
  if (!r.ok) throw new OptimizerError(r.issue);
  return {
    ok: true as const,
    period: { from: u.from, to: u.to, observations: u.observations },
    riskFree: u.riskFree,
    returnMethod: method,
    blackLitterman: bl,
    assets: u.assets.map((a, i) => ({ symbol: a.symbol, assetClass: a.assetClass, expectedReturn: mu[i], volatility: a.volatility, beta: a.beta })),
    skipped: u.skipped,
    objective: r.objective,
    allocations: r.allocations,
    riskyShare: r.riskyShare,
    riskFreeShare: r.riskFreeShare,
    recommended: r.final,
    current: r.current && { expectedReturn: r.current.expectedReturn, volatility: r.current.volatility, sharpe: r.current.sharpe },
    minVariance: { expectedReturn: r.gmv.expectedReturn, volatility: r.gmv.volatility, sharpe: r.gmv.sharpe },
    maxSharpe: r.tangency && { expectedReturn: r.tangency.expectedReturn, volatility: r.tangency.volatility, sharpe: r.tangency.sharpe },
    solver: r.solver,
    constraints: r.constraints,
    covariance: { method: p.covMethod ?? "sample", shrinkage: p.covMethod === "ledoit_wolf" ? u.shrinkage : 0, ...r.covariance, periodsPerYear: u.periodsPerYear },
    warnings: [...u.covarianceWarnings, ...extraWarnings, ...r.warnings],
  };
}

function blackLittermanSummary(b: ReturnType<typeof blackLitterman>, symbols: string[]) {
  return {
    riskAversion: b.riskAversion,
    riskAversionSource: b.riskAversionSource,
    tau: b.tau,
    omegaMethod: "ω = ((1 − confidence) / confidence) · pτΣpᵀ unless a view variance is given",
    assets: symbols.map((s, i) => ({ symbol: s, marketWeight: b.marketWeights[i], prior: b.prior[i], posterior: b.posterior[i], change: b.posterior[i] - b.prior[i] })),
    views: b.views.map(({ label, q, confidence, omega, priorValue, posteriorValue }) => ({ view: label, q, confidence, omega, priorValue, posteriorValue })),
    weights: [] as { symbol: string; market: number; priorOptimal: number | null; posteriorOptimal: number | null }[],
  };
}
