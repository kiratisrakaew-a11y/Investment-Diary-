/**
 * zod schemas for valuation / bond assumptions and a single `evaluate` entry
 * point. Used by the valuation editor (save), the AI advisor tools, MCP and REST.
 * All rates are decimals (0.08 = 8%).
 */
import { z } from "zod";
import {
  costOfEquity,
  dcf,
  dcfSensitivity,
  gordonGrowth,
  hModel,
  impliedGrowthDetailed,
  justifiedPBV,
  justifiedPE,
  multiplesValuation,
  residualIncome,
  scenarioAnalysis,
  SCENARIO_FIELDS,
  twoStageDdm,
  type DcfAssumptions,
} from "./finance/valuation";
import { analyticsFromPrice, analyticsFromYield, horizonReturn, keyRateDurations, priceFromCurve, yieldToWorst, zSpread } from "./finance/bonds";
import { explainValuation, formatValue } from "./valuation-explain";

const rate = (d: string) => z.number().min(-1).max(5).describe(`${d} (decimal, 0.05 = 5%)`);
const money = (d: string) => z.number().describe(d);

/** Where the key market inputs came from (shown next to the result; defaults are illustrative). */
export const inputMetaSchema = z
  .object({
    asOf: z.string().optional().describe("Date the market inputs refer to (YYYY-MM-DD)"),
    rfSource: z.string().optional().describe("Source of the risk-free rate, e.g. ThaiBMA 10Y 2026-10-24"),
    erpSource: z.string().optional().describe("Source of the equity risk premium, e.g. Damodaran Jan 2026 Thailand"),
    betaSource: z.string().optional().describe("Source / window of beta, e.g. 2Y weekly vs SET"),
  })
  .optional();

const scenarioSchema = z.object({
  name: z.string().min(1),
  probability: z.number().min(0).max(1).describe("Probability (decimal); all scenarios must sum to 1"),
  overrides: z.object(Object.fromEntries(SCENARIO_FIELDS.map((f) => [f, z.number().optional()])) as Record<(typeof SCENARIO_FIELDS)[number], z.ZodOptional<z.ZodNumber>>).default({}),
});

export const dcfSchema = z.object({
  revenue0: money("Last fiscal-year revenue (e.g. THB million)"),
  years: z.number().int().min(1).max(20).describe("Explicit forecast years"),
  growthStart: rate("Revenue growth in year 1"),
  growthEnd: rate("Revenue growth in the final forecast year (fades linearly)"),
  terminalGrowth: rate("Perpetual growth after the forecast"),
  ebitMarginStart: rate("EBIT margin in year 1"),
  ebitMarginEnd: rate("EBIT margin in the final year"),
  taxRate: rate("Effective tax rate"),
  daPct: rate("Depreciation & amortisation as % of revenue"),
  capexPct: rate("Capex as % of revenue"),
  nwcPct: rate("Net working capital as % of revenue"),
  debt: money("Total interest-bearing debt (same unit as revenue)"),
  cash: money("Cash & equivalents"),
  otherClaims: money("Minority interest / preferred / other claims").default(0),
  sharesOutstanding: money("Shares outstanding (same unit scale as revenue, e.g. million shares)"),
  currentPrice: money("Current share price"),
  riskFree: rate("Risk-free rate"),
  beta: z.number().describe("Equity beta"),
  equityRiskPremium: rate("Equity risk premium"),
  extraPremium: rate("Additional country / size / specific premium").default(0),
  costOfDebt: rate("Pre-tax cost of debt"),
  targetDebtWeight: z.number().min(0).max(0.95).nullable().default(null).describe("Target D/(D+E); null = market-value weights"),
  debtFinancingRatio: rate("FCFE: share of net reinvestment financed by new debt (fixed_borrowing_ratio policy)").default(0),
  debtPolicy: z.enum(["fixed_borrowing_ratio", "explicit_schedule"]).default("fixed_borrowing_ratio").describe("FCFE borrowing policy"),
  netBorrowingSchedule: z.array(z.number()).max(20).optional().describe("FCFE explicit net borrowing per forecast year (new debt − repayments)"),
  terminalMethod: z
    .enum(["gordon", "stable_roic", "exit_multiple"])
    .default("gordon")
    .describe("gordon = last cash flow × (1+g)/(r−g); stable_roic = reinvestment g/ROIC (FCFF) or g/ROE (FCFE); exit_multiple"),
  terminalRoic: rate("Steady-state return on new invested capital (FCFF, stable_roic)").default(0.12),
  terminalRoe: rate("Steady-state return on equity (FCFE, stable_roic)").default(0.12),
  exitMultiple: z.number().default(8).describe("Terminal EV/EBITDA (FCFF) or P/E (FCFE) when terminalMethod = exit_multiple"),
  midYear: z.boolean().default(false),
  scenarios: z.array(scenarioSchema).max(5).optional().describe("Bear/base/bull overrides with probabilities summing to 1"),
  inputMeta: inputMetaSchema,
});

export const ddmSchema = z.object({
  d0: money("Most recent annual dividend per share"),
  currentPrice: money("Current share price"),
  riskFree: rate("Risk-free rate"),
  beta: z.number(),
  equityRiskPremium: rate("Equity risk premium"),
  extraPremium: rate("Additional premium").default(0),
  model: z.enum(["gordon", "two_stage", "h_model"]).default("two_stage"),
  highGrowth: rate("Growth during the high-growth stage").default(0.05),
  highGrowthYears: z.number().int().min(1).max(30).default(5),
  terminalGrowth: rate("Long-run growth"),
  inputMeta: inputMetaSchema,
});

export const residualIncomeSchema = z.object({
  bookValuePerShare: money("Book value per share"),
  roe: rate("Sustainable return on equity"),
  payoutRatio: rate("Dividend payout ratio").default(0.5),
  currentPrice: money("Current share price"),
  riskFree: rate("Risk-free rate"),
  beta: z.number(),
  equityRiskPremium: rate("Equity risk premium"),
  extraPremium: rate("Additional premium").default(0),
  terminalGrowth: rate("Long-run growth (often ROE × retention)"),
  inputMeta: inputMetaSchema,
});

export const multiplesSchema = z.object({
  eps: money("Earnings per share (trailing or forward)"),
  bookValuePerShare: money("Book value per share"),
  ebitda: money("EBITDA (same unit as net debt)"),
  netDebt: money("Net debt = debt − cash"),
  sharesOutstanding: money("Shares outstanding (same unit scale)"),
  currentPrice: money("Current share price"),
  targetPE: z.number().describe("Peer / historical P/E"),
  targetPBV: z.number().describe("Peer / historical P/BV"),
  targetEvEbitda: z.number().describe("Peer / historical EV/EBITDA"),
  earningsBasis: z.enum(["trailing", "forward"]).optional().describe("Whether EPS / EBITDA and the target multiples are trailing (default) or forward — both sides must use the same basis"),
});

export const bondSchema = z.object({
  settlement: z.string().describe("Settlement date YYYY-MM-DD"),
  maturity: z.string().describe("Maturity date YYYY-MM-DD"),
  couponRate: rate("Annual coupon rate"),
  frequency: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(12)]).default(2),
  cleanPrice: z.number().optional().describe("Clean price per 100 face — give this to solve for YTM"),
  ytm: rate("Yield to maturity — give this to solve for price").optional(),
  callDate: z.string().optional().describe("Single call date (legacy; prefer callSchedule)"),
  callPrice: z.number().optional(),
  callSchedule: z.array(z.object({ date: z.string(), price: z.number() })).max(40).optional().describe("Call dates and prices per 100 — gives yield to each call and yield to worst"),
  issueDate: z.string().optional(),
  firstCouponDate: z.string().optional().describe("For an irregular (short/long) first coupon; must lie on the coupon cycle counted back from maturity"),
  penultimateCouponDate: z.string().optional().describe("For an irregular last coupon period"),
  dayCount: z.enum(["ACT/ACT-ICMA", "ACT/365F", "ACT/360", "30/360"]).default("ACT/ACT-ICMA").describe("Accrued-interest day count — use what the bond's terms specify"),
  businessDay: z.enum(["unadjusted", "following", "modified_following"]).default("unadjusted").describe("Weekend roll of payment dates (no holiday calendar)"),
  endOfMonth: z.boolean().optional(),
  exCouponDays: z.number().int().min(0).max(31).default(0).describe("Calendar days before a coupon during which the bond trades ex-coupon"),
  amortization: z.array(z.object({ date: z.string(), amount: z.number() })).max(40).optional().describe("Principal repaid per 100 face on coupon dates before maturity"),
  zeroCurve: z.array(z.object({ years: z.number().positive(), rate: z.number() })).max(30).optional().describe("Zero (spot) rates, annually compounded — gives curve price, Z-spread and key-rate durations"),
  horizon: z.object({ date: z.string(), reinvestRate: z.number(), exitYield: z.number().optional() }).optional().describe("Realized return if sold on `date`"),
  issuer: z.string().optional(),
  rating: z.string().optional().describe("Credit rating with agency and date, e.g. 'AA- (TRIS, 2026-05)'"),
});

export const valuationInput = z.discriminatedUnion("method", [
  z.object({ method: z.literal("dcf_fcff"), assumptions: dcfSchema }),
  z.object({ method: z.literal("dcf_fcfe"), assumptions: dcfSchema }),
  z.object({ method: z.literal("ddm"), assumptions: ddmSchema }),
  z.object({ method: z.literal("residual_income"), assumptions: residualIncomeSchema }),
  z.object({ method: z.literal("multiples"), assumptions: multiplesSchema }),
  z.object({ method: z.literal("bond"), assumptions: bondSchema }),
]);
export type ValuationInput = z.infer<typeof valuationInput>;

export interface EvaluationSummary {
  /** Intrinsic value per share (or clean price per 100 for bonds). */
  value: number | null;
  price: number | null;
  upside: number | null;
  details: Record<string, unknown>;
}

const upsideOf = (v: number, p: number) => (p > 0 && Number.isFinite(v) ? v / p - 1 : null);
const finite = (v: number) => (Number.isFinite(v) ? v : null);

/** Run any valuation method and return a compact, JSON-friendly summary (with calculation steps for AI tools). */
export function evaluate(input: ValuationInput): EvaluationSummary {
  const summary = evaluateCore(input);
  const e = explainValuation(input);
  if (e) {
    summary.details.calculationSteps = e.steps.map((s) => ({ step: s.label, formula: s.formula, substitution: s.substitution, result: formatValue(s.result, s.unit) }));
    summary.details.sanityWarnings = e.warnings;
  }
  return summary;
}

function evaluateCore(input: ValuationInput): EvaluationSummary {
  switch (input.method) {
    case "dcf_fcff":
    case "dcf_fcfe": {
      const model = input.method === "dcf_fcff" ? "fcff" : "fcfe";
      const a = input.assumptions as DcfAssumptions;
      const r = dcf(a, model);
      const s = dcfSensitivity(a, model);
      const reverse = impliedGrowthDetailed(a, model);
      const scen = a.scenarios?.length ? scenarioAnalysis(a, model, a.scenarios) : null;
      return {
        value: r.valuePerShare,
        price: a.currentPrice,
        upside: r.upside,
        details: {
          costOfEquity: r.costOfEquity,
          wacc: r.wacc,
          discountRate: r.discountRate,
          enterpriseValue: r.enterpriseValue,
          equityValue: r.equityValue,
          terminalValue: r.terminalValue,
          terminalShareOfValue: r.terminalShareOfValue,
          terminal: r.terminal,
          impliedExitMultiple: r.impliedExitMultiple,
          impliedRevenueGrowthAtCurrentPrice: reverse.rate,
          reverseDcf: reverse,
          scenarios: scen,
          forecast: r.years.map((y) => ({
            year: y.year,
            revenue: y.revenue,
            ebit: y.ebit,
            fcff: y.fcff,
            fcfe: y.fcfe,
            ...(model === "fcfe" ? { openingDebt: y.openingDebt, netBorrowing: y.netBorrowing, closingDebt: y.closingDebt, interest: y.interest } : {}),
            pv: y.pv,
          })),
          sensitivity: s,
          errors: r.errors,
          warnings: r.warnings,
        },
      };
    }
    case "ddm": {
      const a = input.assumptions;
      const ke = costOfEquity(a.riskFree, a.beta, a.equityRiskPremium, a.extraPremium);
      const value =
        a.model === "gordon"
          ? gordonGrowth(a.d0, ke, a.terminalGrowth)
          : a.model === "h_model"
            ? hModel(a.d0, ke, a.highGrowth, a.terminalGrowth, a.highGrowthYears / 2)
            : twoStageDdm(a.d0, ke, a.highGrowth, a.highGrowthYears, a.terminalGrowth).value;
      return {
        value: finite(value),
        price: a.currentPrice,
        upside: upsideOf(value, a.currentPrice),
        details: { costOfEquity: ke, dividendYield: a.d0 / a.currentPrice, impliedPE: null },
      };
    }
    case "residual_income": {
      const a = input.assumptions;
      const ke = costOfEquity(a.riskFree, a.beta, a.equityRiskPremium, a.extraPremium);
      const value = residualIncome(a.bookValuePerShare, a.roe, ke, a.terminalGrowth);
      return {
        value: finite(value),
        price: a.currentPrice,
        upside: upsideOf(value, a.currentPrice),
        details: {
          costOfEquity: ke,
          justifiedPBV: finite(justifiedPBV(a.roe, ke, a.terminalGrowth)),
          justifiedPE: finite(justifiedPE(a.payoutRatio, ke, a.terminalGrowth)),
          marketPBV: a.currentPrice / a.bookValuePerShare,
        },
      };
    }
    case "multiples": {
      const a = input.assumptions;
      const m = multiplesValuation(a);
      const vals = [m.pe, m.pbv, m.evEbitda].filter((v) => Number.isFinite(v) && v > 0);
      const avg = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : NaN;
      return {
        value: finite(avg),
        price: a.currentPrice,
        upside: upsideOf(avg, a.currentPrice),
        details: {
          byPE: m.pe,
          byPBV: m.pbv,
          byEvEbitda: m.evEbitda,
          currentPE: a.eps > 0 ? a.currentPrice / a.eps : null,
          currentPBV: a.currentPrice / a.bookValuePerShare,
          currentEvEbitda: a.ebitda > 0 ? (a.currentPrice * a.sharesOutstanding + a.netDebt) / a.ebitda : null,
        },
      };
    }
    case "bond": {
      const a = input.assumptions;
      const spec = {
        settlement: a.settlement,
        maturity: a.maturity,
        couponRate: a.couponRate,
        frequency: a.frequency,
        issueDate: a.issueDate,
        firstCouponDate: a.firstCouponDate,
        penultimateCouponDate: a.penultimateCouponDate,
        dayCount: a.dayCount,
        businessDay: a.businessDay,
        endOfMonth: a.endOfMonth,
        exCouponDays: a.exCouponDays,
        amortization: a.amortization,
      };
      const r = a.cleanPrice != null ? analyticsFromPrice(spec, a.cleanPrice) : analyticsFromYield(spec, a.ytm ?? a.couponRate);
      const calls = [...(a.callSchedule ?? []), ...(a.callDate && a.callPrice ? [{ date: a.callDate, price: a.callPrice }] : [])];
      const worst = calls.length ? yieldToWorst(spec, r.cleanPrice, calls) : null;
      const curve = a.zeroCurve?.length
        ? {
            curvePrice: priceFromCurve(spec, a.zeroCurve).cleanPrice,
            zSpread: zSpread(spec, r.cleanPrice, a.zeroCurve),
            keyRateDurations: keyRateDurations(spec, a.zeroCurve, zSpread(spec, r.cleanPrice, a.zeroCurve)),
          }
        : null;
      const horizon = a.horizon ? horizonReturn(spec, r.cleanPrice, { horizonDate: a.horizon.date, reinvestRate: a.horizon.reinvestRate, exitYield: a.horizon.exitYield }) : null;
      const { flows, ...rest } = r;
      return {
        value: r.cleanPrice,
        price: a.cleanPrice ?? null,
        upside: null,
        details: {
          ...rest,
          yieldToCall: worst?.candidates.filter((c) => c.type === "call") ?? null,
          yieldToWorst: worst && { yield: worst.yield, date: worst.worst.date, type: worst.worst.type },
          curve,
          horizon,
          remainingCashFlows: flows.length,
          credit: { issuer: a.issuer ?? null, rating: a.rating ?? null, note: "Yield รวมค่าชดเชยความเสี่ยงด้านเครดิตและสภาพคล่อง — ไม่ใช่ผลตอบแทนปลอดความเสี่ยง" },
        },
      };
    }
  }
}
