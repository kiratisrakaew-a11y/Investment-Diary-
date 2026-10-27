import { buildSnapshot, type AssetInput, type TxInput } from "@/lib/finance/portfolio";
import { covarianceDiagnostics, estimateInputs, ledoitWolf, type Matrix } from "@/lib/finance/mpt";
import { recommend, type Objective } from "@/lib/finance/recommend";
import { blackLitterman, type BlView } from "@/lib/finance/black-litterman";
import { componentES, riskContribution } from "@/lib/finance/risk-contribution";
import { robustDiagnostics } from "@/lib/finance/robust";
import { buildConstraints, exposureReport, type ConstraintsInput } from "@/lib/finance/exposure";
import { analyticsFromPrice, specFromBondAsset } from "@/lib/finance/bonds";
import { creditProfileSchema } from "@/lib/finance/credit-risk";
import { OptimizerError } from "@/lib/finance/optimizer";
import { beta as calcBeta } from "@/lib/finance/risk";
import { mean } from "@/lib/finance/stats";
import { today } from "@/lib/validation";
import type { AssetClass } from "@/db/schema";
import { listAssets } from "./assets";
import { loadAdjPriceHistory, loadBenchmark, loadFxHistory, loadPriceHistory } from "./prices";
import { bondExpectedReturn, type BondExpected } from "@/lib/finance/bond-expected";
import { SHORT_DISCLAIMER, applyShortPolicy, exposureSummary, shortPolicyInput, withPolicyBounds, type ShortPolicy } from "@/lib/finance/short-policy";
import { MIN_OBS_BY_FREQUENCY, bondReturnInputs, resampleLevels, type SampleFrequency } from "@/lib/finance/bond-returns";
import { alignWithBenchmark, buildLevelSeries, commonDates, returnsOn, type ReturnBasis } from "@/lib/finance/return-series";
import { getSettings, getYieldCurve } from "./settings";
import { getRiskFree } from "./risk-free";
import type { ResolvedRiskFree, RiskFreeRequest } from "@/lib/finance/risk-free";
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
  /** User-maintained risk metadata (null when not set) and bond modified duration from the bond analytics. */
  issuer: string | null;
  sector: string | null;
  rating: string | null;
  modifiedDuration: number | null;
  currency: string;
  /** Bonds: years to maturity from today. */
  yearsToMaturity: number | null;
  /** Bonds: forward horizon expected return (used when bondReturnMethod = yield_horizon). */
  bondExpected: BondExpected | null;
}

export interface OptimizerUniverse {
  ok: boolean;
  reason?: string;
  from: string | null;
  to: string | null;
  observations: number;
  riskFree: number;
  /** Where the risk-free rate came from (resolver output). */
  riskFreeInfo?: ResolvedRiskFree;
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
  returnBasis?: ReturnBasis;
  /** Sampling of the common calendar: daily (default) or last actual observation per week / month. */
  frequency?: SampleFrequency;
  /** Aligned periodic returns (only with `withSeries`): per asset, the benchmark, and price dates (returns end on dates[t + 1]). */
  series?: { returns: number[][]; benchmark: number[] | null; dates: string[] };
}

/**
 * Builds the investable universe: every asset (held or not) with enough price
 * history, its THB returns on the common calendar of actual prints (shared conventions in
 * `return-series.ts`: no forward fill, FX applied once), historical and CAPM expected returns,
 * and the covariance matrix. Default basis: price return (closes); total_return uses the
 * provider's adjusted closes and excludes assets without full coverage.
 */
export async function loadUniverse(lookbackDays = 365 * 3, symbols?: string[], opts: { withSeries?: boolean; returnBasis?: ReturnBasis; riskFree?: RiskFreeRequest; frequency?: SampleFrequency; bond?: { horizonYears?: number; rateShiftBp?: number } } = {}): Promise<OptimizerUniverse> {
  const basis = opts.returnBasis ?? "price_return";
  const frequency = opts.frequency ?? "daily";
  const minObs = MIN_OBS_BY_FREQUENCY[frequency];
  const [assets, txRows, prices, fx, settings, adj, curve] = await Promise.all([
    listAssets(),
    allTransactions(),
    loadPriceHistory(),
    loadFxHistory(),
    getSettings(),
    basis === "total_return" ? loadAdjPriceHistory() : Promise.resolve(null),
    getYieldCurve(),
  ]);
  const bench = await loadBenchmark(settings.benchmarkSymbol);
  // Portfolio Rf from the resolver (curve → Settings fallback); without a curve this equals Settings as before.
  const rfInfo = await getRiskFree({ purpose: "portfolio", ...opts.riskFree });
  if (!rfInfo.ok || rfInfo.rate == null) throw new OptimizerError({ code: "INVALID_INPUT", message: `อัตราปลอดความเสี่ยง: ${rfInfo.errors.join(" · ")}` });
  const rf = rfInfo.rate;
  const erp = settings.equityRiskPremium / 100;
  const from = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

  const txs: TxInput[] = txRows.map((t) => ({ ...t }));
  const assetInputs: AssetInput[] = assets.map((a) => ({ id: a.id, symbol: a.symbol, name: a.name, assetClass: a.assetClass, currency: a.currency }));
  const snap = buildSnapshot(assetInputs, txs, prices, fx, today());
  const valueOf = new Map(snap.positions.map((p) => [p.assetId, p.marketValueThb]));

  const wanted = symbols?.length ? new Set(symbols.map((s) => s.toUpperCase())) : null;
  const skipped: { symbol: string; reason: string }[] = [];
  const candidates = assets.filter((a) => a.assetClass !== "cash" && (!wanted || wanted.has(a.symbol.toUpperCase())));
  const levelsById = new Map<number, [string, number][]>();
  const seriesWarnings: string[] = [];
  const usable = candidates.filter((a) => {
    // Archived = not a new candidate by default (held assets cannot be archived, so holdings never vanish).
    // Hidden-from-holdings is presentation only and does not affect eligibility.
    if (a.archivedAt) {
      skipped.push({ symbol: a.symbol, reason: "เก็บถาวร — ไม่ถูกเลือกโดยค่าเริ่มต้น (นำกลับมาใช้งานที่หน้าสินทรัพย์)" });
      return false;
    }
    const window = prices.get(a.id)?.filter(([d]) => d >= from) ?? [];
    if (frequency === "daily" ? window.length < MIN_OBS : window.length < 2) {
      skipped.push({ symbol: a.symbol, reason: `มีราคาเพียง ${window.length} วัน (ต้องการ ≥ ${frequency === "daily" ? MIN_OBS : 2})` });
      return false;
    }
    const adjMap = adj ? new Map(adj.get(a.id) ?? []) : null;
    // Bonds on a total-return basis: dirty price + coupons from the bond's own schedule (not adj_close).
    const bondTr = basis === "total_return" && a.assetClass === "bond" ? bondReturnInputs(a, window.map(([date, close]) => ({ date, close }))) : null;
    if (bondTr && !bondTr.ok) {
      skipped.push({ symbol: a.symbol, reason: `ผลตอบแทนรวมพันธบัตร: ${bondTr.reason}` });
      return false;
    }
    // Never convert at FX = 1: USD assets need a USDTHB fixing on (or within 5 days before) each date.
    const lv = bondTr?.ok
      ? buildLevelSeries({ label: a.symbol, observations: bondTr.observations, distributions: bondTr.distributions, basis, totalReturnSource: "distributions", source: "bond schedule", currency: a.currency, fx })
      : buildLevelSeries({
          label: a.symbol,
          observations: window.map(([date, close]) => ({ date, close, adjClose: adjMap?.get(date) ?? null })),
          basis,
          totalReturnSource: basis === "total_return" ? "adjusted_close" : undefined,
          currency: a.currency,
          fx,
        });
    if (!lv.ok) {
      skipped.push({ symbol: a.symbol, reason: `${lv.reason}${lv.required ? ` — ต้องการ: ${lv.required}` : ""}` });
      return false;
    }
    seriesWarnings.push(...lv.warnings);
    if (bondTr?.ok) seriesWarnings.push(`${a.symbol}: ผลตอบแทนรวม = ราคา dirty + คูปอง · ${bondTr.notes.join(" · ")}${bondTr.assumed.length ? ` · สมมติ: ${bondTr.assumed.join(", ")}` : ""}`);
    else if (a.assetClass === "bond") seriesWarnings.push(`${a.symbol}: price_return ใช้ราคาอย่างเดียว ไม่รวมคูปอง/ดอกเบี้ยค้างรับ — เลือก returnBasis total_return สำหรับผลตอบแทนรวมของพันธบัตร`);
    const levels = resampleLevels(lv.levels, frequency);
    if (frequency !== "daily" && levels.length < minObs) {
      skipped.push({ symbol: a.symbol, reason: `มีข้อมูลราย${frequency === "weekly" ? "สัปดาห์" : "เดือน"}เพียง ${levels.length} งวด (ต้องการ ≥ ${minObs})` });
      return false;
    }
    levelsById.set(a.id, levels);
    return true;
  });

  const empty: OptimizerUniverse = {
    ok: false,
    from: null,
    to: null,
    observations: 0,
    riskFree: rf,
    riskFreeInfo: rfInfo,
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
  const dates = commonDates(usable.map((a) => levelsById.get(a.id)!));
  if (dates.length < minObs)
    return { ...empty, reason: `${frequency === "daily" ? "วันที่" : "งวดที่"}ทุกสินทรัพย์มีราคาพร้อมกันมีเพียง ${dates.length} (ต้องการ ≥ ${minObs})${frequency === "daily" ? " — ลองความถี่รายสัปดาห์/รายเดือนถ้าพันธบัตร/กองทุนซื้อขายไม่ทุกวัน" : ""}` };

  const series = usable.map((a) => returnsOn(levelsById.get(a.id)!, dates));
  // Observations per year from the data, so daily, weekly or fund-NAV calendars annualize consistently.
  const years = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / (365 * 86_400_000);
  const N = years > 0 ? (dates.length - 1) / years : 252;
  // Benchmark on the asset calendar where it has actual prints at both ends (NaN otherwise) — never forward-filled.
  const benchWindow = resampleLevels(bench.filter(([d]) => d >= from), frequency);
  const benchReturns = benchWindow.length ? returnsOn(benchWindow, dates) : null;
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
    riskFreeInfo: rfInfo,
    equityRiskPremium: erp,
    benchmark: settings.benchmarkSymbol,
    skipped,
    cov,
    covShrunk,
    shrinkage: lw.intensity,
    periodsPerYear: N,
    covarianceWarnings: [...covarianceWarnings, ...seriesWarnings],
    returnBasis: basis,
    frequency,
    ...(opts.withSeries ? { series: { returns: series, benchmark: benchReturns, dates } } : {}),
    assets: usable.map((a, i) => {
      // β on common actual prints of asset and benchmark (compounding across benchmark gaps).
      const al = benchWindow.length ? alignWithBenchmark(levelsById.get(a.id)!, benchWindow, dates) : null;
      const b = al && al.dates.length > 2 ? calcBeta(al.asset, al.benchmark) : null;
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
        issuer: a.issuer ?? null,
        sector: a.sector ?? null,
        rating: a.assetClass === "bond" ? (ratingOf(a.credit) ?? "unrated") : null,
        modifiedDuration: a.assetClass === "bond" ? bondDuration(a, prices.get(a.id)) : null,
        currency: a.currency,
        yearsToMaturity: a.assetClass === "bond" && a.maturityDate ? Math.max(0, (Date.parse(a.maturityDate) - Date.parse(today())) / (365.25 * 86_400_000)) : null,
        bondExpected: a.assetClass === "bond" ? bondForward(a, prices.get(a.id), curve, opts.bond) : null,
      };
    }),
  };
}

/** Forward bond expected return from the last stored price (curve only when its currency matches the bond). */
function bondForward(
  a: { couponRate: number | null; maturityDate: string | null; faceValue: number | null; couponFrequency: number | null; dayCount: string | null; currency: string; credit: unknown },
  series: [string, number][] | undefined,
  curve: Awaited<ReturnType<typeof getYieldCurve>>,
  o: { horizonYears?: number; rateShiftBp?: number } = {},
): BondExpected {
  const last = series?.[series.length - 1];
  if (!last) return { ok: false, reason: "ไม่มีราคา" };
  const credit = creditProfileSchema.safeParse(a.credit ?? {});
  const curveOk = curve && (curve.currency ? curve.currency === a.currency : a.currency === "THB");
  return bondExpectedReturn({
    ...a,
    cleanPerUnit: last[1],
    settlement: today(),
    horizonYears: o.horizonYears,
    rateShiftBp: o.rateShiftBp,
    curve: curveOk ? curve.points : null,
    credit: credit.success ? { pdAnnual: credit.data.pd?.annual ?? null, lgd: credit.data.lgd?.value ?? null } : null,
  });
}

function ratingOf(credit: unknown): string | null {
  const p = creditProfileSchema.safeParse(credit ?? {});
  return p.success ? (p.data.rating ?? null) : null;
}

/** Modified duration from the last stored price (same convention as bondHoldings: stored price = clean per unit). */
function bondDuration(a: Parameters<typeof specFromBondAsset>[0] & { faceValue: number | null }, series: [string, number][] | undefined): number | null {
  const last = series?.[series.length - 1];
  const settlement = today();
  if (a.couponRate == null || !a.maturityDate || !last || a.maturityDate <= settlement) return null;
  try {
    return analyticsFromPrice(specFromBondAsset(a, settlement).spec, a.faceValue ? (last[1] / a.faceValue) * 100 : last[1]).modifiedDuration;
  } catch {
    return null;
  }
}

export type ReturnMethod = "historical" | "capm" | "blend" | "black_litterman";

export type BondReturnMethod = "same_as_other" | "yield_horizon";

export function expectedReturns(u: OptimizerUniverse, method: ReturnMethod, overrides: Record<string, number> = {}, bondMethod: BondReturnMethod = "same_as_other") {
  return u.assets.map((a) => {
    const o = overrides[a.symbol];
    if (o != null) return o;
    if (bondMethod === "yield_horizon" && a.assetClass === "bond" && a.bondExpected?.ok) return a.bondExpected.expectedReturn;
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
  robust?: { bootstrap?: number; returnShock?: number; seed?: number };
  returnBasis?: ReturnBasis;
  constraints?: ConstraintsInput;
  /** risk_parity: budget by symbol (normalized; default equal). */
  riskBudgets?: Record<string, number>;
  /** min_cvar confidence (default 0.95). */
  cvarConfidence?: number;
  /** Risk-free source for Sharpe / CAL (default auto: currency-matched curve, else Settings). */
  riskFree?: RiskFreeRequest;
  /** Common-calendar sampling (default daily). */
  frequency?: SampleFrequency;
  /** Bond expected returns: same estimator as other assets (default) or forward yield / horizon return. */
  bondReturnMethod?: BondReturnMethod;
  bondHorizonYears?: number;
  bondRateShiftBp?: number;
}

export type OptimizeRequest = OptimizeParams & Partial<ShortPolicy>;

/** Server-side recommendation used by the AI advisor, MCP and REST. */
export async function optimizePortfolio(p: OptimizeRequest) {
  const u = await loadUniverse(p.lookbackDays, p.symbols, {
    withSeries: true,
    returnBasis: p.returnBasis,
    riskFree: p.riskFree,
    frequency: p.frequency,
    bond: { horizonYears: p.bondHorizonYears, rateShiftBp: p.bondRateShiftBp },
  });
  if (!u.ok) return { ok: false as const, reason: u.reason, skipped: u.skipped };
  const symbols = u.assets.map((a) => a.symbol);
  const baseCov = p.covMethod === "ledoit_wolf" ? u.covShrunk : u.cov;
  const method = p.returnMethod ?? "blend";
  const bondMethod = p.bondReturnMethod ?? "same_as_other";
  let mu = expectedReturns(u, method, p.overrides, bondMethod);
  let cov = baseCov;
  const extraWarnings: string[] = [];
  if (bondMethod === "yield_horizon")
    for (const a of u.assets.filter((x) => x.assetClass === "bond" && !x.bondExpected?.ok && p.overrides?.[x.symbol] == null))
      extraWarnings.push(`${a.symbol}: คำนวณผลตอบแทนคาดหวังจาก yield ไม่ได้ (${a.bondExpected && !a.bondExpected.ok ? a.bondExpected.reason : "ไม่ใช่พันธบัตร"}) — ใช้วิธี ${method} แทน`);
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
  const wealth = currentValues.reduce((a, b) => a + b, 0) + (p.extraCash ?? 0);
  // Risk-aware constraints (issuer / sector / rating / groups / duration / DV01) → linear rows for the same QP.
  // Short-selling policy first: OFF (default) keeps every weight ≥ 0 and rejects negative minimums.
  const policy = applyShortPolicy(
    p,
    { minWeight: p.minWeight, maxWeight: p.maxWeight, assetMins: Object.fromEntries(Object.entries(p.constraints?.assetBounds ?? {}).map(([k, v]) => [k.toUpperCase(), v.min])) },
    u.assets,
    p.objective,
  );
  if (!policy.ok) throw new OptimizerError(policy.issue);
  extraWarnings.push(...policy.notes);
  const built0 = buildConstraints(u.assets, policy.base, p.constraints, wealth);
  if (built0.unsupported.length) throw new OptimizerError({ code: "UNSUPPORTED_CONSTRAINT", message: `ข้อจำกัดที่ไม่รองรับ: ${built0.unsupported.join(" · ")}` });
  const built = { ...built0, bounds: withPolicyBounds(built0.bounds, policy) };
  extraWarnings.push(...built.warnings);
  const sp = shortPolicyInput.parse({ allowShortSelling: p.allowShortSelling, allowBorrowingAtRiskFree: p.allowBorrowingAtRiskFree, borrowingRate: p.borrowingRate, maxLeverage: p.maxLeverage });
  if (sp.allowBorrowingAtRiskFree && (sp.borrowingRate == null || sp.maxLeverage == null))
    throw new OptimizerError({ code: "INVALID_INPUT", message: "เปิดการกู้ยืมบนเส้น CAL ต้องระบุ borrowingRate และ maxLeverage (อัตรากู้ไม่ถือว่าเท่ากับ Rf)" });
  const constraints = {
    rf: u.riskFree,
    bounds: built.bounds,
    objective: p.objective ?? "max_sharpe",
    riskAversion: p.riskAversion ?? 4,
    targetReturn: p.targetReturn,
    targetRisk: p.targetRisk,
    currentValues,
    totalWealth: wealth,
    useRiskFree: p.useRiskFree ?? false,
    ...(sp.allowBorrowingAtRiskFree ? { borrowing: { rate: sp.borrowingRate!, maxLeverage: sp.maxLeverage! } } : {}),
    ...(p.riskBudgets ? { riskBudgets: symbols.map((s) => p.riskBudgets![s] ?? p.riskBudgets![s.toUpperCase()] ?? 0) } : {}),
    // min_cvar: historical per-period returns of the same universe and window (no new data loader).
    ...(p.objective === "min_cvar" ? { scenarios: u.series?.returns, cvarConfidence: p.cvarConfidence ?? 0.95 } : {}),
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
  // Defence in depth: with shorting OFF no weight may be negative, whatever path produced it.
  if (!sp.allowShortSelling && r.allocations.some((a) => a.weight < -1e-9))
    throw new OptimizerError({ code: "INVALID_INPUT", message: "ระบบตรวจพบน้ำหนักติดลบทั้งที่ปิดการขายชอร์ต — ไม่แสดงผลลัพธ์นี้", suggestion: "แจ้งปัญหานี้พร้อมพารามิเตอร์ที่ใช้" });
  const recommendedWeights = r.allocations.map((a) => a.weight);
  // Risk decomposition of the recommended risky sleeve (weights normalized within risky assets).
  const riskyW = r.risky.weights;
  const risk = {
    ...riskContribution(symbols, riskyW, cov),
    componentES95: u.series ? componentES(symbols, riskyW, u.series.returns) : null,
    note: "สัดส่วนในพอร์ตเสี่ยง (ไม่รวมสินทรัพย์ปลอดความเสี่ยง) · σ ต่อปี · component ES เป็นรายงวด (รายวัน)",
  };
  let robust: ReturnType<typeof robustDiagnostics> | null = null;
  if (p.robust && u.series) {
    const N = u.periodsPerYear;
    const S = u.series;
    const bench = S.benchmark;
    const muFromRows = (rows: number[]) => {
      const sample = S.returns.map((s) => rows.map((t) => s[t]));
      const hist = sample.map((s) => mean(s) * N);
      const b = bench ? rows.map((t) => bench[t]) : null;
      const capm = sample.map((s, i) => {
        // Only pairs where the benchmark had prints at both ends (no forward fill).
        const keep = b ? b.map((v, k) => Number.isFinite(v) && Number.isFinite(s[k])) : [];
        const beta = b ? calcBeta(s.filter((_, k) => keep[k]), b.filter((_, k) => keep[k])) : null;
        return beta != null ? u.riskFree + beta * u.equityRiskPremium : hist[i];
      });
      let m = method === "historical" ? hist : method === "capm" ? capm : method === "blend" ? hist.map((h, i) => 0.5 * h + 0.5 * capm[i]) : hist;
      if (method === "black_litterman" && p.blackLitterman) {
        const sc = p.covMethod === "ledoit_wolf" ? ledoitWolf(sample).cov.map((row) => row.map((v) => v * N)) : estimateInputs(sample, N).cov;
        const b2 = blackLitterman({ symbols, cov: sc, rf: u.riskFree, marketWeights: p.blackLitterman.marketWeights, riskAversion: p.blackLitterman.marketRiskAversion, marketPremium: u.equityRiskPremium, tau: p.blackLitterman.tau ?? 0.05, views: p.blackLitterman.views ?? [] });
        if (b2.ok) m = b2.posterior;
      }
      return m.map((v, i) => p.overrides?.[symbols[i]] ?? v);
    };
    robust = robustDiagnostics({
      series: S.returns,
      periodsPerYear: N,
      covMethod: p.covMethod ?? "sample",
      muFromRows,
      base: { symbols, ...constraints },
      baseWeights: recommendedWeights,
      baseMu: mu,
      baseCov: cov,
      draws: p.robust.bootstrap ?? 100,
      returnShock: p.robust.returnShock ?? 0.02,
      seed: p.robust.seed ?? 42,
    });
  }
  return {
    ok: true as const,
    period: { from: u.from, to: u.to, observations: u.observations },
    riskFree: u.riskFree,
    riskFreeInfo: u.riskFreeInfo,
    returnMethod: method,
    blackLitterman: bl,
    risk,
    exposure: {
      recommended: exposureReport(u.assets, riskyW, built.durations, wealth * r.riskyShare),
      current: wealth > 0 ? exposureReport(u.assets, currentValues.map((v) => v / Math.max(currentValues.reduce((a, b) => a + b, 0), 1e-9)), built.durations, currentValues.reduce((a, b) => a + b, 0)) : null,
      constraintsApplied: (built.bounds.linear ?? []).map((c) => ({ name: c.name, min: c.lo ?? null, max: c.hi ?? null, value: c.a.reduce((s, a, i) => s + a * riskyW[i], 0) })),
      unclassified: built.unclassified,
      note: "สัดส่วนของพอร์ตเสี่ยง · duration ของพันธบัตรจากราคาล่าสุด (อื่น ๆ = 0 ถ้าไม่ระบุ durationOverride)",
    },
    robust,
    assets: u.assets.map((a, i) => ({ symbol: a.symbol, assetClass: a.assetClass, expectedReturn: mu[i], volatility: a.volatility, beta: a.beta })),
    skipped: u.skipped,
    objective: r.objective,
    allocations: r.allocations,
    ...(r.riskBased
      ? {
          riskBased: {
            ...r.riskBased,
            riskShares: Object.fromEntries(symbols.map((s, i) => [s, r.riskBased!.riskShares[i]])),
            ...(r.riskBased.budgets ? { budgets: Object.fromEntries(symbols.map((s, i) => [s, r.riskBased!.budgets![i]])) } : {}),
          },
        }
      : {}),
    riskyShare: r.riskyShare,
    riskFreeShare: r.riskFreeShare,
    shortSelling: {
      allowed: sp.allowShortSelling,
      exposure: exposureSummary(r.allocations.map((a) => a.weight)),
      limits: sp.allowShortSelling ? { maxShortPerAsset: p.maxShortPerAsset ?? null, maxGrossExposure: p.maxGrossExposure ?? null } : null,
      disclaimer: sp.allowShortSelling ? SHORT_DISCLAIMER : null,
    },
    borrowing: { allowed: sp.allowBorrowingAtRiskFree, rate: sp.borrowingRate ?? null, maxLeverage: sp.maxLeverage ?? null },
    riskFreeSleeve: {
      share: r.riskFreeShare,
      note: "สัดส่วนปลอดความเสี่ยงเป็นสถานะจำลองบนเส้น CAL (เงินฝาก/ตั๋วระยะสั้นที่อัตรา Rf) — ไม่ได้ผูกกับพันธบัตรที่ถือ และไม่ถูกนับซ้ำกับน้ำหนักพันธบัตรในพอร์ตเสี่ยง",
    },
    bondReturns: {
      method: bondMethod,
      assets: u.assets.filter((a) => a.assetClass === "bond").map((a) => ({ symbol: a.symbol, used: mu[u.assets.indexOf(a)], forward: a.bondExpected, yearsToMaturity: a.yearsToMaturity, modifiedDuration: a.modifiedDuration })),
    },
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
