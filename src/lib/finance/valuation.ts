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

  terminalMethod: "gordon" | "exit_multiple";
  /** EV/EBITDA used when terminalMethod = exit_multiple (FCFE uses P/E on net income). */
  exitMultiple: number;
  midYear: boolean;
}

export interface DcfYear {
  year: number;
  revenue: number;
  growth: number;
  ebit: number;
  ebitMargin: number;
  nopat: number;
  da: number;
  capex: number;
  deltaNwc: number;
  fcff: number;
  interest: number;
  netIncome: number;
  netBorrowing: number;
  fcfe: number;
  discountFactor: number;
  pv: number;
}

export interface DcfResult {
  model: "fcff" | "fcfe";
  costOfEquity: number;
  wacc: number;
  discountRate: number;
  years: DcfYear[];
  sumPvCashFlows: number;
  terminalValue: number;
  pvTerminalValue: number;
  terminalShareOfValue: number;
  enterpriseValue: number | null;
  equityValue: number;
  valuePerShare: number;
  upside: number | null;
  impliedExitMultiple: number | null;
  impliedPerpetualGrowth: number | null;
  warnings: string[];
}

const lerp = (a: number, b: number, i: number, n: number) => (n <= 1 ? b : a + ((b - a) * i) / (n - 1));

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

/** Builds the operating forecast shared by FCFF and FCFE. */
function forecast(a: DcfAssumptions, model: "fcff" | "fcfe", rate: number): DcfYear[] {
  const out: DcfYear[] = [];
  let prevRevenue = a.revenue0;
  let debt = a.debt;
  for (let i = 0; i < a.years; i++) {
    const growth = lerp(a.growthStart, a.growthEnd, i, a.years);
    const revenue = prevRevenue * (1 + growth);
    const ebitMargin = lerp(a.ebitMarginStart, a.ebitMarginEnd, i, a.years);
    const ebit = revenue * ebitMargin;
    const nopat = ebit * (1 - a.taxRate);
    const da = revenue * a.daPct;
    const capex = revenue * a.capexPct;
    const deltaNwc = (revenue - prevRevenue) * a.nwcPct;
    const fcff = nopat + da - capex - deltaNwc;
    const interest = debt * a.costOfDebt;
    const netIncome = (ebit - interest) * (1 - a.taxRate);
    const netBorrowing = a.debtFinancingRatio * (capex - da + deltaNwc);
    const fcfe = netIncome - (capex - da) - deltaNwc + netBorrowing;
    debt += netBorrowing;
    const t = a.midYear ? i + 0.5 : i + 1;
    const discountFactor = 1 / (1 + rate) ** t;
    out.push({
      year: i + 1,
      revenue,
      growth,
      ebit,
      ebitMargin,
      nopat,
      da,
      capex,
      deltaNwc,
      fcff,
      interest,
      netIncome,
      netBorrowing,
      fcfe,
      discountFactor,
      pv: (model === "fcff" ? fcff : fcfe) * discountFactor,
    });
    prevRevenue = revenue;
  }
  return out;
}

export function dcf(a: DcfAssumptions, model: "fcff" | "fcfe"): DcfResult {
  const warnings: string[] = [];
  const { ke, wacc: w } = discountRates(a);
  const rate = model === "fcff" ? w : ke;
  const years = forecast(a, model, rate);
  const last = years[years.length - 1];
  const g = a.terminalGrowth;
  // Terminal value is discounted from the end of the final year (no mid-year shift).
  const tvDiscount = 1 / (1 + rate) ** a.years;

  let terminalValue: number;
  if (a.terminalMethod === "gordon") {
    if (rate <= g) warnings.push("อัตราคิดลดต้องมากกว่า terminal growth (r > g)");
    // Steady state: next year's cash flow with the same reinvestment ratio.
    const cfNext = (model === "fcff" ? last.fcff : last.fcfe) * (1 + g);
    terminalValue = rate > g ? cfNext / (rate - g) : NaN;
  } else {
    terminalValue =
      model === "fcff" ? (last.ebit + last.da) * a.exitMultiple : last.netIncome * a.exitMultiple;
  }
  const pvTerminalValue = terminalValue * tvDiscount;
  const sumPv = years.reduce((s, y) => s + y.pv, 0);

  let enterpriseValue: number | null = null;
  let equityValue: number;
  if (model === "fcff") {
    enterpriseValue = sumPv + pvTerminalValue;
    equityValue = enterpriseValue - a.debt + a.cash - a.otherClaims;
  } else {
    // FCFE already belongs to equity holders; add non-operating cash (its interest is not in FCFE).
    equityValue = sumPv + pvTerminalValue + a.cash;
  }
  const valuePerShare = a.sharesOutstanding > 0 ? equityValue / a.sharesOutstanding : NaN;
  const totalPv = sumPv + pvTerminalValue;
  const share = totalPv !== 0 ? pvTerminalValue / totalPv : 0;
  if (share > 0.8) warnings.push("Terminal value > 80% ของมูลค่า — ผลลัพธ์อ่อนไหวต่อ g และอัตราคิดลดมาก");
  if (g > a.riskFree + 0.01) warnings.push("Terminal growth สูงกว่าอัตราผลตอบแทนพันธบัตร (proxy ของ nominal GDP growth) ค่อนข้างมาก");
  if (last.fcff < 0 && model === "fcff") warnings.push("FCFF ปีสุดท้ายติดลบ — ตรวจสอบ capex / NWC");

  const cfLast = model === "fcff" ? last.fcff : last.fcfe;
  const multipleBase = model === "fcff" ? last.ebit + last.da : last.netIncome;
  const impliedExitMultiple = multipleBase > 0 ? terminalValue / multipleBase : null;
  // g implied by an exit-multiple TV: TV = CF(1+g)/(r−g) → g = (TV·r − CF)/(TV + CF)
  const impliedPerpetualGrowth =
    Number.isFinite(terminalValue) && terminalValue + cfLast !== 0 ? (terminalValue * rate - cfLast) / (terminalValue + cfLast) : null;

  return {
    model,
    costOfEquity: ke,
    wacc: w,
    discountRate: rate,
    years,
    sumPvCashFlows: sumPv,
    terminalValue,
    pvTerminalValue,
    terminalShareOfValue: share,
    enterpriseValue,
    equityValue,
    valuePerShare,
    upside: a.currentPrice > 0 && Number.isFinite(valuePerShare) ? valuePerShare / a.currentPrice - 1 : null,
    impliedExitMultiple,
    impliedPerpetualGrowth,
    warnings,
  };
}

/** Value per share across a grid of discount-rate and terminal-growth shifts. */
export function dcfSensitivity(
  a: DcfAssumptions,
  model: "fcff" | "fcfe",
  rateShifts = [-0.02, -0.01, 0, 0.01, 0.02],
  growthShifts = [-0.01, -0.005, 0, 0.005, 0.01],
) {
  const base = dcf(a, model);
  return {
    rates: rateShifts.map((s) => base.discountRate + s),
    growths: growthShifts.map((s) => a.terminalGrowth + s),
    grid: rateShifts.map((rs) =>
      growthShifts.map((gs) => dcfAtRate({ ...a, terminalGrowth: a.terminalGrowth + gs }, model, base.discountRate + rs)),
    ),
  };
}

/** DCF value per share at an explicitly given discount rate. */
export function dcfAtRate(a: DcfAssumptions, model: "fcff" | "fcfe", rate: number): number {
  const years = forecast(a, model, rate);
  const last = years[years.length - 1];
  const g = a.terminalGrowth;
  const tv =
    a.terminalMethod === "gordon"
      ? rate > g
        ? ((model === "fcff" ? last.fcff : last.fcfe) * (1 + g)) / (rate - g)
        : NaN
      : model === "fcff"
        ? (last.ebit + last.da) * a.exitMultiple
        : last.netIncome * a.exitMultiple;
  const total = years.reduce((s, y) => s + y.pv, 0) + tv / (1 + rate) ** a.years;
  const equity = model === "fcff" ? total - a.debt + a.cash - a.otherClaims : total + a.cash;
  return a.sharesOutstanding > 0 ? equity / a.sharesOutstanding : NaN;
}

/** Reverse DCF: the constant revenue growth that justifies the current price. */
export function impliedGrowth(a: DcfAssumptions, model: "fcff" | "fcfe"): number | null {
  if (a.currentPrice <= 0) return null;
  const { ke, wacc: w } = discountRates(a);
  const rate = model === "fcff" ? w : ke;
  const f = (g: number) => dcfAtRate({ ...a, growthStart: g, growthEnd: g }, model, rate) - a.currentPrice;
  let lo = -0.5;
  let hi = 1.0;
  if (f(lo) * f(hi) > 0) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
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
  terminalMethod: "gordon",
  exitMultiple: 8,
  midYear: false,
};
