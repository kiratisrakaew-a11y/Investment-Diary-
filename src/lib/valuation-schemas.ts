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
  impliedGrowth,
  justifiedPBV,
  justifiedPE,
  multiplesValuation,
  residualIncome,
  twoStageDdm,
  type DcfAssumptions,
} from "./finance/valuation";
import { analyticsFromPrice, analyticsFromYield, yieldToCall } from "./finance/bonds";
import { explainValuation, formatValue } from "./valuation-explain";

const rate = (d: string) => z.number().min(-1).max(5).describe(`${d} (decimal, 0.05 = 5%)`);
const money = (d: string) => z.number().describe(d);

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
  debtFinancingRatio: rate("FCFE: share of net reinvestment financed by new debt").default(0),
  terminalMethod: z.enum(["gordon", "exit_multiple"]).default("gordon"),
  exitMultiple: z.number().default(8).describe("Terminal EV/EBITDA (FCFF) or P/E (FCFE) when terminalMethod = exit_multiple"),
  midYear: z.boolean().default(false),
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
});

export const bondSchema = z.object({
  settlement: z.string().describe("Settlement date YYYY-MM-DD"),
  maturity: z.string().describe("Maturity date YYYY-MM-DD"),
  couponRate: rate("Annual coupon rate"),
  frequency: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(12)]).default(2),
  cleanPrice: z.number().optional().describe("Clean price per 100 face — give this to solve for YTM"),
  ytm: rate("Yield to maturity — give this to solve for price").optional(),
  callDate: z.string().optional(),
  callPrice: z.number().optional(),
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
      return {
        value: finite(r.valuePerShare),
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
          impliedExitMultiple: r.impliedExitMultiple,
          impliedRevenueGrowthAtCurrentPrice: impliedGrowth(a, model),
          forecast: r.years.map((y) => ({
            year: y.year,
            revenue: y.revenue,
            ebit: y.ebit,
            fcff: y.fcff,
            fcfe: y.fcfe,
            pv: y.pv,
          })),
          sensitivity: s,
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
      const spec = { settlement: a.settlement, maturity: a.maturity, couponRate: a.couponRate, frequency: a.frequency };
      const r = a.cleanPrice != null ? analyticsFromPrice(spec, a.cleanPrice) : analyticsFromYield(spec, a.ytm ?? a.couponRate);
      const ytc = a.callDate && a.callPrice && a.cleanPrice != null ? yieldToCall(spec, a.cleanPrice, a.callDate, a.callPrice) : null;
      const { flows, ...rest } = r;
      return {
        value: r.cleanPrice,
        price: a.cleanPrice ?? null,
        upside: null,
        details: { ...rest, yieldToCall: ytc, remainingCashFlows: flows.length },
      };
    }
  }
}
