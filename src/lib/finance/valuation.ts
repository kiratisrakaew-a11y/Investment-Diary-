/**
 * Equity valuation models. Pure functions, safe to run in the browser so the
 * assumption editor recalculates instantly. All rates are decimals (0.08 = 8%).
 *
 * References: Damodaran, "Investment Valuation"; CFA Institute equity valuation curriculum.
 */

// ---------------------------------------------------------------- discount rates

/** CAPM cost of equity: Ke = Rf + β·ERP (+ optional country/size/specific premium). */
export function costOfEquity(rf: number, beta: number, erp: number, extraPremium = 0): number {
  return rf + beta * erp + extraPremium;
}

/** WACC = E/(D+E)·Ke + D/(D+E)·Kd·(1 − t) */
export function wacc(ke: number, kdPreTax: number, taxRate: number, equityValue: number, debtValue: number): number {
  const v = equityValue + debtValue;
  if (v <= 0) return ke;
  return (equityValue / v) * ke + (debtValue / v) * kdPreTax * (1 - taxRate);
}

/** Hamada: unlevered β → levered β at a given D/E. */
export function leverBeta(unleveredBeta: number, debtToEquity: number, taxRate: number): number {
  return unleveredBeta * (1 + (1 - taxRate) * debtToEquity);
}

export function unleverBeta(leveredBeta: number, debtToEquity: number, taxRate: number): number {
  return leveredBeta / (1 + (1 - taxRate) * debtToEquity);
}

// ---------------------------------------------------------------- DCF (FCFF / FCFE)

/**
 * Terminal value methods:
 * - `gordon`: last explicit cash flow × (1 + g) / (r − g) (keeps the final year's reinvestment ratio).
 * - `stable_roic`: steady state where reinvestment = g / ROIC (FCFF) or g / ROE (FCFE).
 * - `exit_multiple`: EBITDA × EV/EBITDA (FCFF) or net income × P/E (FCFE) at the end of year n.
 */
export type TerminalMethod = "gordon" | "stable_roic" | "exit_multiple";

/**
 * FCFE borrowing policy:
 * - `fixed_borrowing_ratio`: net borrowing = δ × net reinvestment (capex − D&A + ΔNWC).
 * - `explicit_schedule`: net borrowing per year from `netBorrowingSchedule`.
 */
export type DebtPolicy = "fixed_borrowing_ratio" | "explicit_schedule";

export interface InputMeta {
  asOf?: string;
  rfSource?: string;
  erpSource?: string;
  betaSource?: string;
}

/**
 * One stage of a staged DCF forecast. Growth and EBIT margin move linearly from start to end
 * within the stage; reinvestment, tax and FCFE δ default to the base assumptions when omitted.
 */
export interface DcfStage {
  id?: string;
  name?: string;
  years: number;
  revenueGrowthStart: number;
  revenueGrowthEnd: number;
  ebitMarginStart: number;
  ebitMarginEnd: number;
  daPct?: number;
  capexPct?: number;
  nwcPct?: number;
  taxRate?: number;
  debtFinancingRatio?: number;
}

export type ForecastMode = "linear_fade" | "staged";

/** Drivers for one explicit forecast year (the single annual table both modes produce). */
export interface YearDriver {
  stage: number | null;
  growth: number;
  ebitMargin: number;
  daPct: number;
  capexPct: number;
  nwcPct: number;
  taxRate: number;
  debtFinancingRatio: number;
}

export interface DcfAssumptions {
  /** Last fiscal year revenue (in currency units, e.g. THB millions). */
  revenue0: number;
  /** Explicit forecast horizon (years). */
  years: number;
  /** Revenue growth in year 1. */
  growthStart: number;
  /** Revenue growth in the final forecast year (linear fade from growthStart). */
  growthEnd: number;
  /** Perpetual growth after the forecast horizon. */
  terminalGrowth: number;
  /** EBIT margin in year 1 and in the final year (linear path). */
  ebitMarginStart: number;
  ebitMarginEnd: number;
  taxRate: number;
  /** Depreciation & amortisation, capex as % of revenue. */
  daPct: number;
  capexPct: number;
  /** Net working capital as % of revenue (ΔNWC = nwcPct × ΔRevenue). */
  nwcPct: number;

  // Capital structure & market data
  debt: number;
  cash: number;
  /** Minority interest / preferred / other claims deducted from EV. */
  otherClaims: number;
  sharesOutstanding: number;
  currentPrice: number;

  // Discount rate
  riskFree: number;
  beta: number;
  equityRiskPremium: number;
  extraPremium: number;
  costOfDebt: number;
  /** Target D/(D+E). If null, market-value weights (price × shares, debt) are used. */
  targetDebtWeight: number | null;

  /** FCFE: share of net reinvestment financed with new debt (δ in Damodaran's FCFE). */
  debtFinancingRatio: number;
  debtPolicy: DebtPolicy;
  /** FCFE explicit net borrowing (new debt − repayments) per forecast year. */
  netBorrowingSchedule?: number[];

  terminalMethod: TerminalMethod;
  /** Return on new invested capital in the steady state (FCFF, stable_roic). */
  terminalRoic: number;
  /** Return on equity in the steady state (FCFE, stable_roic). */
  terminalRoe: number;
  /** EV/EBITDA used when terminalMethod = exit_multiple (FCFE uses P/E on net income). */
  exitMultiple: number;
  midYear: boolean;
  /**
   * FCFE only: whether forecast net income is attributable to the parent (default — minority
   * interest already excluded) or consolidated (minorities' share included, so `otherClaims`
   * is deducted in the bridge).
   */
  netIncomeBasis?: "attributable" | "consolidated";

  scenarios?: DcfScenario[];
  inputMeta?: InputMeta;
  /** Absent or "linear_fade" = legacy single fade (growthStart → growthEnd). */
  forecastMode?: ForecastMode;
  /** forecastMode "staged": 2–4 ordered stages; the horizon is Σ stage years (1–20). */
  stages?: DcfStage[];
}

export interface DcfYear {
  year: number;
  /** Stage index (0-based) in staged mode; null in linear-fade mode. */
  stage?: number | null;
  revenue: number;
  growth: number;
  ebit: number;
  ebitMargin: number;
  nopat: number;
  da: number;
  capex: number;
  deltaNwc: number;
  fcff: number;
  openingDebt: number;
  interest: number;
  netIncome: number;
  netBorrowing: number;
  closingDebt: number;
  fcfe: number;
  discountFactor: number;
  pv: number;
}

export type DcfIssueCode =
  | "RATE_NOT_ABOVE_GROWTH"
  | "INVALID_SHARES"
  | "INVALID_TAX"
  | "NEGATIVE_REVENUE"
  | "INVALID_YEARS"
  | "INVALID_TERMINAL_RETURN"
  | "INVALID_RATE"
  | "INVALID_STAGES"
  | "INVALID_INPUT";

export interface DcfIssue {
  code: DcfIssueCode;
  message: string;
}

export interface TerminalDetail {
  method: TerminalMethod;
  /** Normalized year n+1 cash flow (Gordon / stable methods). */
  cashFlowNext: number | null;
  /** NOPAT (FCFF) or net income (FCFE) in year n+1. */
  earningsNext: number | null;
  /** 1 − CF(n+1) / earnings(n+1): share of earnings reinvested in the steady state. */
  reinvestmentRate: number | null;
  /** ROIC (FCFF) or ROE (FCFE) implied by g / reinvestment rate. */
  impliedReturnOnCapital: number | null;
  /** TV ÷ EBITDA(n) for FCFF, TV ÷ net income(n) for FCFE. */
  impliedMultiple: number | null;
  multipleLabel: "EV/EBITDA" | "P/E";
  /** Years used to discount the terminal value (n, or n − 0.5 for perpetuities under mid-year). */
  discountYears: number;
}

export interface DcfResult {
  model: "fcff" | "fcfe";
  costOfEquity: number;
  wacc: number;
  discountRate: number;
  years: DcfYear[];
  sumPvCashFlows: number;
  terminalValue: number | null;
  pvTerminalValue: number | null;
  terminalShareOfValue: number | null;
  terminal: TerminalDetail;
  enterpriseValue: number | null;
  equityValue: number | null;
  valuePerShare: number | null;
  upside: number | null;
  impliedExitMultiple: number | null;
  impliedPerpetualGrowth: number | null;
  errors: DcfIssue[];
  warnings: string[];
}

const lerp = (a: number, b: number, i: number, n: number) => (n <= 1 ? b : a + ((b - a) * i) / (n - 1));

const isStaged = (a: DcfAssumptions) => a.forecastMode === "staged";

/** Explicit horizon: Σ stage years in staged mode, else `years`. */
export function forecastYears(a: DcfAssumptions): number {
  return isStaged(a) ? (a.stages ?? []).reduce((s, st) => s + st.years, 0) : a.years;
}

/**
 * Per-year drivers. Linear fade: one global line from start to end (legacy, unchanged). Staged: the
 * same linear rule applied inside each stage, stage-level reinvestment / tax / δ overriding the base.
 */
export function yearDrivers(a: DcfAssumptions): YearDriver[] {
  const base = { daPct: a.daPct, capexPct: a.capexPct, nwcPct: a.nwcPct, taxRate: a.taxRate, debtFinancingRatio: a.debtFinancingRatio };
  if (!isStaged(a)) {
    return Array.from({ length: a.years }, (_, i) => ({ stage: null, growth: lerp(a.growthStart, a.growthEnd, i, a.years), ebitMargin: lerp(a.ebitMarginStart, a.ebitMarginEnd, i, a.years), ...base }));
  }
  const out: YearDriver[] = [];
  (a.stages ?? []).forEach((st, k) => {
    for (let j = 0; j < st.years; j++) {
      out.push({
        stage: k,
        growth: lerp(st.revenueGrowthStart, st.revenueGrowthEnd, j, st.years),
        ebitMargin: lerp(st.ebitMarginStart, st.ebitMarginEnd, j, st.years),
        daPct: st.daPct ?? base.daPct,
        capexPct: st.capexPct ?? base.capexPct,
        nwcPct: st.nwcPct ?? base.nwcPct,
        taxRate: st.taxRate ?? base.taxRate,
        debtFinancingRatio: st.debtFinancingRatio ?? base.debtFinancingRatio,
      });
    }
  });
  return out;
}

/** Same assumptions with `years` = the stage total, so downstream code sees one horizon. */
function effective(a: DcfAssumptions): DcfAssumptions {
  return isStaged(a) ? { ...a, years: forecastYears(a) } : a;
}

/** Structural checks for staged mode (never clamped). */
function validateStages(a: DcfAssumptions): DcfIssue[] {
  if (!isStaged(a)) return [];
  const st = a.stages ?? [];
  const out: DcfIssue[] = [];
  if (st.length < 2 || st.length > 4) out.push({ code: "INVALID_STAGES", message: `โหมดหลายช่วงต้องมี 2–4 ช่วง (มี ${st.length})` });
  st.forEach((s, k) => {
    const label = s.name || `ช่วงที่ ${k + 1}`;
    if (!(Number.isInteger(s.years) && s.years >= 1)) out.push({ code: "INVALID_STAGES", message: `${label}: จำนวนปีต้องเป็นจำนวนเต็ม ≥ 1` });
    const nums = [s.revenueGrowthStart, s.revenueGrowthEnd, s.ebitMarginStart, s.ebitMarginEnd, s.daPct, s.capexPct, s.nwcPct, s.taxRate, s.debtFinancingRatio].filter((v) => v !== undefined);
    if (!nums.every((v) => Number.isFinite(v))) out.push({ code: "INVALID_STAGES", message: `${label}: มีค่าที่ไม่ใช่ตัวเลข` });
    if (s.taxRate != null && !(s.taxRate >= 0 && s.taxRate <= 1)) out.push({ code: "INVALID_TAX", message: `${label}: อัตราภาษีต้องอยู่ระหว่าง 0% ถึง 100%` });
    if ([s.revenueGrowthStart, s.revenueGrowthEnd].some((g) => !(g > -1))) out.push({ code: "INVALID_STAGES", message: `${label}: การเติบโตต้องมากกว่า −100%` });
  });
  const total = forecastYears(a);
  if (st.length && !(total >= 1 && total <= 20)) out.push({ code: "INVALID_STAGES", message: `รวมปีทุกช่วง ${total} ปี — ต้องอยู่ระหว่าง 1–20 ปี` });
  return out;
}

/** Plausibility warnings for staged inputs (shown, not enforced). */
function stageWarnings(a: DcfAssumptions): string[] {
  if (!isStaged(a)) return [];
  const st = a.stages ?? [];
  const out: string[] = [];
  const total = forecastYears(a);
  if (a.years !== total) out.push(`โหมดหลายช่วง: ใช้จำนวนปีรวมของทุกช่วง (${total} ปี) แทนค่า years = ${a.years}`);
  st.forEach((s, k) => {
    const label = s.name || `ช่วงที่ ${k + 1}`;
    if (Math.max(s.ebitMarginStart, s.ebitMarginEnd) > 0.6) out.push(`${label}: EBIT margin เกิน 60% — ตรวจสอบความสมเหตุสมผล`);
    if (Math.min(s.ebitMarginStart, s.ebitMarginEnd) < -0.5) out.push(`${label}: EBIT margin ติดลบมาก`);
    const next = st[k + 1];
    if (next) {
      if (Math.abs(next.revenueGrowthStart - s.revenueGrowthEnd) > 0.05) out.push(`รอยต่อ ${label} → ${next.name || `ช่วงที่ ${k + 2}`}: growth กระโดด ${((next.revenueGrowthStart - s.revenueGrowthEnd) * 100).toFixed(1)} จุด`);
      if (Math.abs(next.ebitMarginStart - s.ebitMarginEnd) > 0.05) out.push(`รอยต่อ ${label} → ${next.name || `ช่วงที่ ${k + 2}`}: EBIT margin กระโดด ${((next.ebitMarginStart - s.ebitMarginEnd) * 100).toFixed(1)} จุด`);
    }
  });
  const last = st[st.length - 1];
  if (last && Math.abs(last.revenueGrowthEnd - a.terminalGrowth) > 0.03) out.push(`ช่วงสุดท้ายจบที่ growth ${(last.revenueGrowthEnd * 100).toFixed(1)}% ห่างจาก terminal growth ${(a.terminalGrowth * 100).toFixed(1)}% — ช่วงสุดท้ายควรเข้าใกล้ steady state`);
  return out;
}
const finiteOrNull = (v: number) => (Number.isFinite(v) ? v : null);

function discountRates(a: DcfAssumptions) {
  const ke = costOfEquity(a.riskFree, a.beta, a.equityRiskPremium, a.extraPremium);
  let w: number;
  if (a.targetDebtWeight != null) {
    const d = a.targetDebtWeight;
    w = (1 - d) * ke + d * a.costOfDebt * (1 - a.taxRate);
  } else {
    w = wacc(ke, a.costOfDebt, a.taxRate, a.currentPrice * a.sharesOutstanding, a.debt);
  }
  return { ke, wacc: w };
}

/** Structural input checks; any issue makes the fair value unavailable. */
export function validateDcf(a0: DcfAssumptions, model: "fcff" | "fcfe", rate = model === "fcff" ? discountRates(a0).wacc : discountRates(a0).ke): DcfIssue[] {
  const a = effective(a0);
  const out: DcfIssue[] = [...validateStages(a0)];
  const nums = [a.revenue0, a.years, a.growthStart, a.growthEnd, a.terminalGrowth, a.ebitMarginStart, a.ebitMarginEnd, a.taxRate, a.daPct, a.capexPct, a.nwcPct, a.debt, a.cash, a.otherClaims, a.sharesOutstanding];
  if (!nums.every(Number.isFinite)) out.push({ code: "INVALID_INPUT", message: "มีสมมติฐานที่ไม่ใช่ตัวเลข" });
  if (!(a.sharesOutstanding > 0)) out.push({ code: "INVALID_SHARES", message: "จำนวนหุ้นต้องมากกว่า 0" });
  if (!(a.taxRate >= 0 && a.taxRate <= 1)) out.push({ code: "INVALID_TAX", message: "อัตราภาษีต้องอยู่ระหว่าง 0% ถึง 100%" });
  if (a.revenue0 < 0) out.push({ code: "NEGATIVE_REVENUE", message: "รายได้ต้องไม่ติดลบ" });
  if (!(Number.isInteger(a.years) && a.years >= 1)) out.push({ code: "INVALID_YEARS", message: "จำนวนปีประมาณการต้องเป็นจำนวนเต็ม ≥ 1" });
  if (!(rate > -1) || !Number.isFinite(rate)) out.push({ code: "INVALID_RATE", message: "อัตราคิดลดไม่ถูกต้อง" });
  if (a.terminalMethod !== "exit_multiple" && !(rate > a.terminalGrowth)) {
    out.push({ code: "RATE_NOT_ABOVE_GROWTH", message: `อัตราคิดลด (${(rate * 100).toFixed(2)}%) ต้องมากกว่า terminal growth (${(a.terminalGrowth * 100).toFixed(2)}%) — สูตร perpetuity ใช้ไม่ได้` });
  }
  if (a.terminalMethod === "stable_roic") {
    const ret = model === "fcff" ? a.terminalRoic : a.terminalRoe;
    if (!(ret != null && ret > 0)) out.push({ code: "INVALID_TERMINAL_RETURN", message: `Terminal ${model === "fcff" ? "ROIC" : "ROE"} ต้องมากกว่า 0` });
  }
  return out;
}

/** Builds the operating forecast and debt schedule shared by FCFF and FCFE. */
function forecast(a: DcfAssumptions, model: "fcff" | "fcfe", rate: number): DcfYear[] {
  const out: DcfYear[] = [];
  let prevRevenue = a.revenue0;
  let debt = a.debt;
  const explicit = a.debtPolicy === "explicit_schedule";
  const drivers = yearDrivers(a);
  for (let i = 0; i < drivers.length; i++) {
    const d = drivers[i];
    const growth = d.growth;
    const revenue = prevRevenue * (1 + growth);
    const ebitMargin = d.ebitMargin;
    const ebit = revenue * ebitMargin;
    const nopat = ebit * (1 - d.taxRate);
    const da = revenue * d.daPct;
    const capex = revenue * d.capexPct;
    const deltaNwc = (revenue - prevRevenue) * d.nwcPct;
    const fcff = nopat + da - capex - deltaNwc;
    const openingDebt = debt;
    // Interest accrues on the debt outstanding at the start of the year.
    const interest = openingDebt * a.costOfDebt;
    const netIncome = (ebit - interest) * (1 - d.taxRate);
    const netBorrowing = explicit ? (a.netBorrowingSchedule?.[i] ?? 0) : d.debtFinancingRatio * (capex - da + deltaNwc);
    const fcfe = netIncome - (capex - da) - deltaNwc + netBorrowing;
    debt = openingDebt + netBorrowing;
    const t = a.midYear ? i + 0.5 : i + 1;
    const discountFactor = 1 / (1 + rate) ** t;
    out.push({
      year: i + 1,
      stage: d.stage,
      revenue,
      growth,
      ebit,
      ebitMargin,
      nopat,
      da,
      capex,
      deltaNwc,
      fcff,
      openingDebt,
      interest,
      netIncome,
      netBorrowing,
      closingDebt: debt,
      fcfe,
      discountFactor,
      pv: (model === "fcff" ? fcff : fcfe) * discountFactor,
    });
    prevRevenue = revenue;
  }
  return out;
}

/** Terminal value at the end of year n plus the year n+1 reconciliation. */
function terminal(a: DcfAssumptions, model: "fcff" | "fcfe", rate: number, last: DcfYear): { tv: number; detail: TerminalDetail } {
  const g = a.terminalGrowth;
  const earningsLast = model === "fcff" ? last.nopat : last.netIncome;
  const multipleBase = model === "fcff" ? last.ebit + last.da : last.netIncome;
  const multipleLabel = model === "fcff" ? ("EV/EBITDA" as const) : ("P/E" as const);
  // Perpetuity flows arrive mid-year too under the mid-year convention; an exit multiple is a point-in-time price at n.
  const discountYears = a.midYear && a.terminalMethod !== "exit_multiple" ? a.years - 0.5 : a.years;

  let tv: number;
  let cashFlowNext: number | null = null;
  let earningsNext: number | null = null;
  let reinvestmentRate: number | null = null;
  if (a.terminalMethod === "exit_multiple") {
    tv = multipleBase * a.exitMultiple;
  } else {
    earningsNext = earningsLast * (1 + g);
    if (a.terminalMethod === "stable_roic") {
      const ret = (model === "fcff" ? a.terminalRoic : a.terminalRoe) ?? NaN;
      reinvestmentRate = g / ret;
      cashFlowNext = earningsNext * (1 - reinvestmentRate);
    } else {
      cashFlowNext = (model === "fcff" ? last.fcff : last.fcfe) * (1 + g);
      reinvestmentRate = earningsNext !== 0 ? 1 - cashFlowNext / earningsNext : null;
    }
    tv = rate > g ? cashFlowNext / (rate - g) : NaN;
  }
  const impliedReturnOnCapital = reinvestmentRate != null && reinvestmentRate > 1e-12 && g > 0 ? g / reinvestmentRate : null;
  return {
    tv,
    detail: {
      method: a.terminalMethod,
      cashFlowNext,
      earningsNext,
      reinvestmentRate,
      impliedReturnOnCapital,
      impliedMultiple: multipleBase > 0 && Number.isFinite(tv) ? tv / multipleBase : null,
      multipleLabel,
      discountYears,
    },
  };
}

function bridge(a: DcfAssumptions, model: "fcff" | "fcfe", pvTotal: number) {
  // FCFF: EV less debt-like claims plus non-operating cash.
  // FCFE: interest income on cash is not in the forecast net income, so cash is added once.
  return model === "fcff" ? pvTotal - a.debt + a.cash - a.otherClaims : pvTotal + a.cash - (a.netIncomeBasis === "consolidated" ? a.otherClaims : 0);
}

function compute(a0: DcfAssumptions, model: "fcff" | "fcfe", rate: number) {
  const errors = validateDcf(a0, model, rate);
  const a = effective(a0);
  const years = forecast(a, model, rate);
  const last = years[years.length - 1];
  const t = last ? terminal(a, model, rate, last) : null;
  const sumPv = years.reduce((s, y) => s + y.pv, 0);
  const tv = errors.length || !t ? NaN : t.tv;
  const pvTv = tv / (1 + rate) ** (t?.detail.discountYears ?? a.years);
  const equity = bridge(a, model, sumPv + pvTv);
  return {
    errors,
    years,
    last,
    terminal: t,
    sumPv,
    tv: finiteOrNull(tv),
    pvTv: finiteOrNull(pvTv),
    equity: finiteOrNull(equity),
    perShare: a.sharesOutstanding > 0 ? finiteOrNull(equity / a.sharesOutstanding) : null,
  };
}

export function dcf(a0: DcfAssumptions, model: "fcff" | "fcfe"): DcfResult {
  const a = effective(a0);
  const warnings: string[] = [...stageWarnings(a0)];
  const { ke, wacc: w } = discountRates(a);
  const rate = model === "fcff" ? w : ke;
  const c = compute(a0, model, rate);
  const g = a.terminalGrowth;
  const last = c.last;
  const detail: TerminalDetail = c.terminal?.detail ?? {
    method: a.terminalMethod,
    cashFlowNext: null,
    earningsNext: null,
    reinvestmentRate: null,
    impliedReturnOnCapital: null,
    impliedMultiple: null,
    multipleLabel: model === "fcff" ? "EV/EBITDA" : "P/E",
    discountYears: a.years,
  };

  const totalPv = c.pvTv != null ? c.sumPv + c.pvTv : null;
  const share = totalPv != null && totalPv !== 0 && c.pvTv != null ? c.pvTv / totalPv : null;
  if (share != null && share > 0.8) warnings.push("Terminal value > 80% ของมูลค่า — ผลลัพธ์ขึ้นกับสมมติฐานระยะยาวเกือบทั้งหมด อ่อนไหวต่อ g และอัตราคิดลดมาก");
  else if (share != null && share > 0.7) warnings.push("Terminal value > 70% ของมูลค่า — ควรตรวจ sensitivity ของ g และอัตราคิดลด");
  if (g > a.riskFree + 0.01) warnings.push("Terminal growth สูงกว่าอัตราผลตอบแทนพันธบัตร (proxy ของ nominal GDP growth) ค่อนข้างมาก");
  if (last && last.fcff < 0 && model === "fcff") warnings.push("FCFF ปีสุดท้ายติดลบ — ตรวจสอบ capex / NWC");
  if (model === "fcfe" && a.otherClaims > 0 && a.netIncomeBasis == null)
    warnings.push("FCFE: มีส่วนของผู้ถือหุ้นส่วนน้อย/ภาระอื่น แต่ไม่ได้ระบุว่ากำไรที่ประมาณการเป็นส่วนของบริษัทใหญ่หรือรวมทั้งกลุ่ม — ถ้ารวมทั้งกลุ่ม ให้ตั้ง netIncomeBasis = consolidated เพื่อหักส่วนน้อย (ค่าเริ่มต้นถือว่าเป็นส่วนของบริษัทใหญ่ จึงไม่หัก)");

  if (a.terminalMethod === "gordon" && last) {
    const rr = detail.reinvestmentRate;
    if (g > 0 && rr != null && rr <= 1e-12) {
      warnings.push("Terminal: เติบโตต่อเนื่องโดยไม่มี reinvestment (capex ≈ D&A, ΔNWC ≈ 0) เท่ากับสมมติ ROIC ไม่จำกัด — พิจารณาใช้วิธี stable ROIC");
    } else if (detail.impliedReturnOnCapital != null && detail.impliedReturnOnCapital > 0.4) {
      warnings.push(`Terminal: ${model === "fcff" ? "ROIC" : "ROE"} ที่แฝงอยู่ = ${(detail.impliedReturnOnCapital * 100).toFixed(1)}% สูงมากสำหรับ steady state`);
    }
    if (model === "fcfe" && Math.abs(last.netBorrowing) > 1e-9) {
      warnings.push("Terminal FCFE ใช้ FCFE ปีสุดท้ายที่รวมการกู้สุทธิ — ถ้าระดับการกู้ไม่ยั่งยืนให้ใช้วิธี stable ROE");
    }
  }
  if (a.terminalMethod === "stable_roic" && detail.reinvestmentRate != null && detail.reinvestmentRate > 1) {
    warnings.push(`Terminal growth สูงกว่า ${model === "fcff" ? "ROIC" : "ROE"} — reinvestment เกิน 100% ของกำไร ทำให้กระแสเงินสดปลายงวดติดลบ`);
  }
  if (a.debtPolicy === "explicit_schedule" && model === "fcfe" && (a.netBorrowingSchedule?.length ?? 0) !== a.years) {
    warnings.push(`ตารางกู้สุทธิมี ${a.netBorrowingSchedule?.length ?? 0} ปี แต่ประมาณการ ${a.years} ปี — ปีที่ขาดถือว่ากู้สุทธิ = 0`);
  }
  if (last && model === "fcfe" && last.closingDebt < 0) warnings.push("หนี้ปลายงวดติดลบ — ตรวจตารางกู้สุทธิ");

  const cfLast = last ? (model === "fcff" ? last.fcff : last.fcfe) : NaN;
  // g implied by an exit-multiple TV: TV = CF(1+g)/(r−g) → g = (TV·r − CF)/(TV + CF)
  const impliedPerpetualGrowth = c.tv != null && c.tv + cfLast !== 0 ? finiteOrNull((c.tv * rate - cfLast) / (c.tv + cfLast)) : null;
  const enterpriseValue = model === "fcff" && totalPv != null ? totalPv : null;

  return {
    model,
    costOfEquity: ke,
    wacc: w,
    discountRate: rate,
    years: c.years,
    sumPvCashFlows: c.sumPv,
    terminalValue: c.tv,
    pvTerminalValue: c.pvTv,
    terminalShareOfValue: share,
    terminal: detail,
    enterpriseValue: c.errors.length ? null : enterpriseValue,
    equityValue: c.errors.length ? null : c.equity,
    valuePerShare: c.errors.length ? null : c.perShare,
    upside: !c.errors.length && c.perShare != null && a.currentPrice > 0 ? c.perShare / a.currentPrice - 1 : null,
    impliedExitMultiple: model === "fcff" ? detail.impliedMultiple : null,
    impliedPerpetualGrowth: a.terminalMethod === "exit_multiple" ? impliedPerpetualGrowth : null,
    errors: c.errors,
    warnings,
  };
}

/** DCF value per share at an explicitly given discount rate; null when the inputs are invalid. */
export function dcfAtRate(a: DcfAssumptions, model: "fcff" | "fcfe", rate: number): number | null {
  const c = compute(a, model, rate);
  return c.errors.length ? null : c.perShare;
}

export type SensitivityAxis = "terminalGrowth" | "terminalRoic" | "ebitMargin" | "capexPct" | "debtFinancingRatio";

export const SENSITIVITY_AXES: Record<SensitivityAxis, { label: string; shifts: number[] }> = {
  terminalGrowth: { label: "Terminal growth (g)", shifts: [-0.01, -0.005, 0, 0.005, 0.01] },
  terminalRoic: { label: "Terminal ROIC / ROE", shifts: [-0.04, -0.02, 0, 0.02, 0.04] },
  ebitMargin: { label: "EBIT margin (ทุกปี)", shifts: [-0.02, -0.01, 0, 0.01, 0.02] },
  capexPct: { label: "Capex / รายได้", shifts: [-0.02, -0.01, 0, 0.01, 0.02] },
  debtFinancingRatio: { label: "สัดส่วนกู้ δ (FCFE)", shifts: [-0.2, -0.1, 0, 0.1, 0.2] },
};

function shifted(a: DcfAssumptions, model: "fcff" | "fcfe", axis: SensitivityAxis, s: number): { a: DcfAssumptions; x: number } {
  switch (axis) {
    case "terminalGrowth":
      return { a: { ...a, terminalGrowth: a.terminalGrowth + s }, x: a.terminalGrowth + s };
    case "terminalRoic": {
      const key = model === "fcff" ? "terminalRoic" : "terminalRoe";
      const v = (a[key] ?? 0) + s;
      return { a: { ...a, terminalMethod: "stable_roic", [key]: v }, x: v };
    }
    case "ebitMargin": {
      // Staged: shift every stage's margins too (the axis label shows the final-year margin).
      const stages = isStaged(a) ? a.stages?.map((st) => ({ ...st, ebitMarginStart: st.ebitMarginStart + s, ebitMarginEnd: st.ebitMarginEnd + s })) : a.stages;
      const lastEnd = isStaged(a) && stages?.length ? stages[stages.length - 1].ebitMarginEnd : a.ebitMarginEnd + s;
      return { a: { ...a, stages, ebitMarginStart: a.ebitMarginStart + s, ebitMarginEnd: a.ebitMarginEnd + s }, x: lastEnd };
    }
    case "capexPct": {
      const stages = isStaged(a) ? a.stages?.map((st) => (st.capexPct != null ? { ...st, capexPct: st.capexPct + s } : st)) : a.stages;
      return { a: { ...a, stages, capexPct: a.capexPct + s }, x: a.capexPct + s };
    }
    case "debtFinancingRatio": {
      const stages = isStaged(a) ? a.stages?.map((st) => (st.debtFinancingRatio != null ? { ...st, debtFinancingRatio: st.debtFinancingRatio + s } : st)) : a.stages;
      return { a: { ...a, stages, debtFinancingRatio: a.debtFinancingRatio + s }, x: a.debtFinancingRatio + s };
    }
  }
}

/** Value per share across discount-rate shifts (rows) and one other driver (columns); invalid cells are null. */
export function dcfSensitivity(a: DcfAssumptions, model: "fcff" | "fcfe", axis: SensitivityAxis = "terminalGrowth", rateShifts = [-0.02, -0.01, 0, 0.01, 0.02]) {
  const base = dcf(a, model);
  const cols = SENSITIVITY_AXES[axis].shifts.map((s) => shifted(a, model, axis, s));
  return {
    axis,
    axisLabel: SENSITIVITY_AXES[axis].label,
    rates: rateShifts.map((s) => base.discountRate + s),
    columns: cols.map((c) => c.x),
    grid: rateShifts.map((rs) => cols.map((c) => dcfAtRate(c.a, model, base.discountRate + rs))),
  };
}

export interface ImpliedGrowthResult {
  /** Constant growth (linear fade) or the uniform shift added to every stage's growth (staged). */
  rate: number | null;
  basis?: "constant_growth" | "stage_shift";
  status: "ok" | "no_root" | "multiple_roots" | "unavailable";
  candidates: number[];
}

/**
 * Reverse DCF: the constant explicit-period revenue growth that justifies the current price.
 * Scans −50%…+100% for sign changes and bisects each bracket, so multiple or missing roots are reported.
 */
export function impliedGrowthDetailed(a: DcfAssumptions, model: "fcff" | "fcfe"): ImpliedGrowthResult {
  if (!(a.currentPrice > 0)) return { rate: null, status: "unavailable", candidates: [] };
  const { ke, wacc: w } = discountRates(a);
  const rate = model === "fcff" ? w : ke;
  // Linear fade: constant growth g. Staged: a uniform shift g added to every stage's growth path.
  const staged = isStaged(a);
  const f = (g: number) => {
    const shiftedA = staged ? { ...a, stages: a.stages?.map((st) => ({ ...st, revenueGrowthStart: st.revenueGrowthStart + g, revenueGrowthEnd: st.revenueGrowthEnd + g })) } : { ...a, growthStart: g, growthEnd: g };
    const v = dcfAtRate(shiftedA, model, rate);
    return v == null ? NaN : v - a.currentPrice;
  };
  const candidates: number[] = [];
  const N = 150;
  let x0 = -0.5;
  let f0 = f(x0);
  for (let i = 1; i <= N; i++) {
    const x1 = -0.5 + (1.5 * i) / N;
    const f1 = f(x1);
    if (Number.isFinite(f0) && Number.isFinite(f1) && f0 * f1 <= 0) {
      let lo = x0;
      let hi = x1;
      let flo = f0;
      for (let k = 0; k < 100; k++) {
        const mid = (lo + hi) / 2;
        const fm = f(mid);
        if (flo * fm <= 0) hi = mid;
        else {
          lo = mid;
          flo = fm;
        }
      }
      const root = (lo + hi) / 2;
      if (!candidates.some((c) => Math.abs(c - root) < 1e-6)) candidates.push(root);
    }
    x0 = x1;
    f0 = f1;
  }
  const basis = staged ? ("stage_shift" as const) : ("constant_growth" as const);
  if (!candidates.length) return { rate: null, status: "no_root", candidates, basis };
  if (candidates.length > 1) return { rate: null, status: "multiple_roots", candidates, basis };
  return { rate: candidates[0], status: "ok", candidates, basis };
}

/** Reverse DCF growth, or null when it is not uniquely defined. */
export function impliedGrowth(a: DcfAssumptions, model: "fcff" | "fcfe"): number | null {
  return impliedGrowthDetailed(a, model).rate;
}

export const SCENARIO_FIELDS = ["growthStart", "growthEnd", "ebitMarginStart", "ebitMarginEnd", "terminalGrowth", "capexPct", "terminalRoic", "terminalRoe"] as const;
export type ScenarioField = (typeof SCENARIO_FIELDS)[number];

export interface DcfScenario {
  name: string;
  probability: number;
  overrides: Partial<Record<ScenarioField, number>>;
  /** Staged mode: per-stage absolute overrides by stage index (fields left out keep the base stage). */
  stageOverrides?: (Partial<Omit<DcfStage, "id" | "name" | "years">> | null)[];
}

const FADE_FIELDS: ScenarioField[] = ["growthStart", "growthEnd", "ebitMarginStart", "ebitMarginEnd"];

/** Scenario assumptions; in staged mode the fade fields are refused (they would be silently ignored). */
export function applyScenario(a: DcfAssumptions, s: DcfScenario): { a: DcfAssumptions; error?: string } {
  if (isStaged(a)) {
    const fade = FADE_FIELDS.filter((f) => s.overrides[f] != null);
    if (fade.length) return { a, error: `โหมดหลายช่วงใช้ stageOverrides แทน ${fade.join(", ")}` };
    if ((s.stageOverrides?.length ?? 0) > (a.stages?.length ?? 0)) return { a, error: "stageOverrides มีมากกว่าจำนวนช่วง" };
    const stages = a.stages?.map((st, k) => ({ ...st, ...(s.stageOverrides?.[k] ?? {}) }));
    return { a: { ...a, ...s.overrides, stages } };
  }
  if (s.stageOverrides?.some((o) => o)) return { a, error: "stageOverrides ใช้ได้เฉพาะโหมดหลายช่วง" };
  return { a: { ...a, ...s.overrides } };
}

/** Bear / base / bull style scenarios: value per scenario and the probability-weighted fair value. */
export function scenarioAnalysis(a: DcfAssumptions, model: "fcff" | "fcfe", scenarios: DcfScenario[]) {
  const errors: string[] = [];
  const rows = scenarios.map((s) => {
    const applied = applyScenario(a, s);
    if (applied.error) return { name: s.name, probability: s.probability, value: null, upside: null, errors: [applied.error] };
    const r = dcf(applied.a, model);
    return { name: s.name, probability: s.probability, value: r.valuePerShare, upside: r.upside, errors: r.errors.map((e) => e.message) };
  });
  return aggregateScenarios(rows, a.currentPrice, errors);
}

export interface ScenarioRow {
  name: string;
  probability: number;
  value: number | null;
  upside: number | null;
  errors: string[];
}

/**
 * Probability-weighted summary shared by every model's scenarios: the expected value is shown only
 * when probabilities are non-negative, sum to 100% and every scenario has a value.
 */
export function aggregateScenarios<R extends ScenarioRow>(rows: R[], price: number, errors: string[] = []) {
  const total = rows.reduce((t, s) => t + s.probability, 0);
  if (!rows.length) errors.push("ไม่มี scenario");
  if (rows.some((s) => !(s.probability >= 0))) errors.push("ความน่าจะเป็นต้องไม่ติดลบ");
  if (Math.abs(total - 1) > 1e-6) errors.push(`ความน่าจะเป็นรวม ${(total * 100).toFixed(1)}% — ต้องเท่ากับ 100%`);
  rows.forEach((r) => {
    if (r.value == null) errors.push(`${r.name}: คำนวณไม่ได้ (${r.errors.join(", ") || "ข้อมูลไม่ครบ"})`);
  });
  const vals = rows.map((r) => r.value).filter((v): v is number => v != null);
  const ok = !errors.length;
  const expectedValue = ok ? rows.reduce((t, r) => t + r.probability * r.value!, 0) : null;
  const stdev = ok && expectedValue != null ? Math.sqrt(rows.reduce((t, r) => t + r.probability * (r.value! - expectedValue) ** 2, 0)) : null;
  return {
    rows,
    expectedValue,
    expectedUpside: expectedValue != null && price > 0 ? expectedValue / price - 1 : null,
    stdev,
    low: vals.length ? Math.min(...vals) : null,
    high: vals.length ? Math.max(...vals) : null,
    errors,
  };
}

/** Starting bear / base / bull set around the current assumptions (illustrative; edit before relying on it). */
export function defaultScenarios(a: DcfAssumptions): DcfScenario[] {
  if (isStaged(a) && a.stages?.length) {
    // Same illustrative rule applied per stage: growth ±2 points, margins ±15% of their level.
    const shiftStages = (dg: number, m: number) => a.stages!.map((st) => ({ revenueGrowthStart: st.revenueGrowthStart + dg, revenueGrowthEnd: st.revenueGrowthEnd + dg, ebitMarginStart: st.ebitMarginStart * m, ebitMarginEnd: st.ebitMarginEnd * m }));
    return [
      { name: "Bear", probability: 0.25, overrides: {}, stageOverrides: shiftStages(-0.02, 0.85) },
      { name: "Base", probability: 0.5, overrides: {} },
      { name: "Bull", probability: 0.25, overrides: {}, stageOverrides: shiftStages(0.02, 1.15) },
    ];
  }
  // Growth ±2 percentage points; margins ±15% of their level (so thin-margin businesses are not swung to zero).
  const shift = (dg: number, m: number) => ({
    growthStart: a.growthStart + dg,
    growthEnd: a.growthEnd + dg,
    ebitMarginStart: a.ebitMarginStart * m,
    ebitMarginEnd: a.ebitMarginEnd * m,
  });
  return [
    { name: "Bear", probability: 0.25, overrides: shift(-0.02, 0.85) },
    { name: "Base", probability: 0.5, overrides: {} },
    { name: "Bull", probability: 0.25, overrides: shift(0.02, 1.15) },
  ];
}

// ---------------------------------------------------------------- Dividend discount

/** Gordon growth: P0 = D1 / (Ke − g), D1 = D0·(1+g). */
export function gordonGrowth(d0: number, ke: number, g: number): number {
  return ke > g ? (d0 * (1 + g)) / (ke - g) : NaN;
}

/** Two-stage DDM: high growth g1 for n years, then g2 forever. */
export function twoStageDdm(d0: number, ke: number, g1: number, n: number, g2: number) {
  let pv = 0;
  let d = d0;
  const dividends: { year: number; dividend: number; pv: number }[] = [];
  for (let t = 1; t <= n; t++) {
    d *= 1 + g1;
    const p = d / (1 + ke) ** t;
    pv += p;
    dividends.push({ year: t, dividend: d, pv: p });
  }
  const terminal = ke > g2 ? (d * (1 + g2)) / (ke - g2) : NaN;
  const pvTerminal = terminal / (1 + ke) ** n;
  return { value: pv + pvTerminal, pvDividends: pv, terminal, pvTerminal, dividends };
}

/** H-model (Fuller & Hsia): growth declines linearly from gS to gL over 2H years. */
export function hModel(d0: number, ke: number, gShort: number, gLong: number, halfLife: number): number {
  return ke > gLong ? (d0 * (1 + gLong) + d0 * halfLife * (gShort - gLong)) / (ke - gLong) : NaN;
}

/** Sustainable growth g = ROE × retention ratio. */
export function sustainableGrowth(roe: number, payoutRatio: number): number {
  return roe * (1 - payoutRatio);
}

// ---------------------------------------------------------------- Residual income & multiples

/** Single-stage residual income: V0 = B0 + (ROE − Ke)·B0 / (Ke − g). */
export function residualIncome(bookValuePerShare: number, roe: number, ke: number, g: number): number {
  return ke > g ? bookValuePerShare + ((roe - ke) * bookValuePerShare) / (ke - g) : NaN;
}

export interface RiForecastYear {
  /** ROE on opening book value (decimal). Ignored when `eps` is given. */
  roe?: number;
  /** Earnings per share for the year; overrides ROE × opening book value. */
  eps?: number;
  /** Dividend payout ratio (decimal); defaults to the base payout. */
  payoutRatio?: number;
  /** Stated book value per share at year end; overrides clean surplus (the gap is flagged). */
  bookValueEnd?: number;
}

export type RiTerminal =
  | { method: "none" }
  | { method: "perpetuity"; growth: number; roe?: number }
  | { method: "persistence"; persistence: number; roe?: number };

export interface RiYear {
  year: number;
  bookValueStart: number;
  roe: number;
  earnings: number;
  dividends: number;
  bookValueEnd: number;
  equityCharge: number;
  residualIncome: number;
  discountFactor: number;
  pv: number;
  /** Where earnings came from: an EPS override or ROE × opening book value. */
  earningsSource?: "eps" | "roe";
  /** Year-end book value: stated (override) or clean surplus B + E − D. */
  bookValueSource?: "stated" | "clean_surplus";
  /** Stated minus clean-surplus book value (0 when clean surplus). */
  cleanSurplusGap?: number;
}

/**
 * Multi-stage residual income: V₀ = B₀ + Σ RIₜ/(1+Ke)ᵗ + PV(continuing value), RIₜ = Eₜ − Ke·Bₜ₋₁,
 * with clean-surplus book values Bₜ = Bₜ₋₁ + Eₜ − Dₜ unless a stated book value is given.
 * Continuing value at year n: none (RI = 0), perpetuity RIₙ₊₁/(Ke − g) with RIₙ₊₁ = (ROE − Ke)·Bₙ,
 * or persistence RIₙ₊₁/(1 + Ke − ω).
 */
export function multiStageResidualIncome(i: { bookValuePerShare: number; ke: number; forecast: RiForecastYear[]; terminal: RiTerminal; payoutRatio?: number }) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { ke } = i;
  if (!(i.bookValuePerShare > 0)) errors.push("Book value ต่อหุ้นเริ่มต้นต้องมากกว่า 0");
  if (!i.forecast.length) errors.push("ต้องมีประมาณการอย่างน้อย 1 ปี");
  if (!(ke > -1)) errors.push("Ke ไม่ถูกต้อง");
  const years: RiYear[] = [];
  let b = i.bookValuePerShare;
  i.forecast.forEach((f, k) => {
    if (f.eps == null && f.roe == null) errors.push(`ปีที่ ${k + 1}: ต้องระบุ ROE หรือ EPS`);
    const earnings = f.eps ?? (f.roe ?? 0) * b;
    const payout = f.payoutRatio ?? i.payoutRatio ?? 0;
    if (!(payout >= 0 && payout <= 1)) warnings.push(`ปีที่ ${k + 1}: payout ${(payout * 100).toFixed(1)}% อยู่นอกช่วง 0–100% — จ่ายเกินกำไรหรือติดลบ ทำให้ book value ลดลง/ผิดปกติ`);
    if (f.eps != null && f.roe != null && b !== 0 && Math.abs(f.eps / b - f.roe) > 1e-6)
      warnings.push(`ปีที่ ${k + 1}: ใช้ EPS ${f.eps.toFixed(2)} ที่ระบุแทน ROE — ROE ที่ได้จริง ${((f.eps / b) * 100).toFixed(2)}% (ROE ${(f.roe * 100).toFixed(2)}% ที่กรอกไว้ไม่ถูกใช้)`);
    const dividends = earnings * payout;
    const clean = b + earnings - dividends;
    const end = f.bookValueEnd ?? clean;
    if (f.bookValueEnd != null && Math.abs(f.bookValueEnd - clean) > 1e-6 * Math.max(1, Math.abs(clean))) {
      warnings.push(`ปีที่ ${k + 1}: Book value ที่ระบุ (${end.toFixed(2)}) ต่างจาก clean surplus B + E − D (${clean.toFixed(2)}) — มีรายการนอกกำไร/ทุนเพิ่ม ทำให้ RI อาจนับไม่ครบหรือซ้ำ`);
    }
    if (end <= 0) errors.push(`ปีที่ ${k + 1}: Book value ปลายปีติดลบหรือเป็นศูนย์`);
    const equityCharge = ke * b;
    const ri = earnings - equityCharge;
    const df = 1 / (1 + ke) ** (k + 1);
    years.push({
      year: k + 1,
      bookValueStart: b,
      roe: b !== 0 ? earnings / b : NaN,
      earnings,
      dividends,
      bookValueEnd: end,
      equityCharge,
      residualIncome: ri,
      discountFactor: df,
      pv: ri * df,
      earningsSource: f.eps != null ? "eps" : "roe",
      bookValueSource: f.bookValueEnd != null ? "stated" : "clean_surplus",
      cleanSurplusGap: end - clean,
    });
    b = end;
  });
  const n = years.length;
  const last = years[n - 1];
  const t = i.terminal;
  let riNext: number | null = null;
  let tv = 0;
  if (t.method !== "none" && last) {
    const roeT = t.roe ?? last.roe;
    riNext = (roeT - ke) * b;
    if (t.method === "perpetuity") {
      if (!(ke > t.growth)) errors.push(`Ke (${(ke * 100).toFixed(2)}%) ต้องมากกว่า growth ระยะยาว (${(t.growth * 100).toFixed(2)}%)`);
      tv = riNext / (ke - t.growth);
      const sustainable = roeT * (1 - (i.forecast[n - 1].payoutRatio ?? i.payoutRatio ?? 0));
      if (t.growth > sustainable + 1e-9) warnings.push(`Growth ระยะยาว ${(t.growth * 100).toFixed(2)}% สูงกว่าที่ ROE × retention รองรับ (${(sustainable * 100).toFixed(2)}%)`);
    } else {
      if (!(t.persistence >= 0 && t.persistence <= 1)) errors.push("Persistence factor ต้องอยู่ระหว่าง 0 ถึง 1");
      tv = riNext / (1 + ke - t.persistence);
    }
    if (roeT > ke + 0.08 && t.method === "perpetuity") warnings.push(`ROE ระยะยาว ${(roeT * 100).toFixed(1)}% สูงกว่า Ke มากตลอดไป — พิจารณาใช้ persistence (ค่อย ๆ ลดลงสู่ Ke)`);
  }
  const pvRi = years.reduce((a, y) => a + y.pv, 0);
  const pvTv = n ? tv / (1 + ke) ** n : 0;
  const value = errors.length ? null : i.bookValuePerShare + pvRi + pvTv;
  const total = value != null ? value - i.bookValuePerShare : null;
  if (total != null && total !== 0 && Math.abs(pvTv / total) > 0.7 && t.method !== "none") warnings.push("Continuing value มากกว่า 70% ของมูลค่าส่วนเกิน book value — ผลลัพธ์อ่อนไหวต่อสมมติฐานระยะยาว");
  return { years, residualIncomeNext: riNext, terminalValue: errors.length ? null : tv, pvResidualIncome: pvRi, pvTerminalValue: errors.length ? null : pvTv, value, errors, warnings };
}

/** Justified (fundamental) trailing P/E = payout·(1+g) / (Ke − g). */
export function justifiedPE(payoutRatio: number, ke: number, g: number): number {
  return ke > g ? (payoutRatio * (1 + g)) / (ke - g) : NaN;
}

/** Justified P/BV = (ROE − g) / (Ke − g). */
export function justifiedPBV(roe: number, ke: number, g: number): number {
  return ke > g ? (roe - g) / (ke - g) : NaN;
}

export interface MultiplesInput {
  eps: number;
  bookValuePerShare: number;
  ebitda: number;
  netDebt: number;
  sharesOutstanding: number;
  targetPE: number;
  targetPBV: number;
  targetEvEbitda: number;
}

export function multiplesValuation(m: MultiplesInput) {
  return {
    pe: m.eps * m.targetPE,
    pbv: m.bookValuePerShare * m.targetPBV,
    evEbitda: m.sharesOutstanding > 0 ? (m.ebitda * m.targetEvEbitda - m.netDebt) / m.sharesOutstanding : NaN,
  };
}

/** Margin of safety relative to intrinsic value: 1 − price / value. */
export function marginOfSafety(intrinsic: number, price: number): number | null {
  return intrinsic > 0 ? 1 - price / intrinsic : null;
}

export const DEFAULT_DCF: DcfAssumptions = {
  revenue0: 100_000,
  years: 5,
  growthStart: 0.06,
  growthEnd: 0.04,
  terminalGrowth: 0.025,
  ebitMarginStart: 0.12,
  ebitMarginEnd: 0.12,
  taxRate: 0.2,
  daPct: 0.04,
  capexPct: 0.05,
  nwcPct: 0.1,
  debt: 30_000,
  cash: 10_000,
  otherClaims: 0,
  sharesOutstanding: 5_000,
  currentPrice: 30,
  riskFree: 0.025,
  beta: 1,
  equityRiskPremium: 0.07,
  extraPremium: 0,
  costOfDebt: 0.04,
  targetDebtWeight: null,
  debtFinancingRatio: 0.3,
  debtPolicy: "fixed_borrowing_ratio",
  terminalMethod: "gordon",
  terminalRoic: 0.12,
  terminalRoe: 0.12,
  exitMultiple: 8,
  midYear: false,
};
