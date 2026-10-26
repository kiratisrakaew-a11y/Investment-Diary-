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
  multiStageResidualIncome,
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
  terminalGrowth: rate("Long-run growth (often ROE × retention); used by the perpetuity continuing value"),
  forecast: z
    .array(
      z.object({
        roe: rate("ROE on opening book value for this year").optional(),
        eps: z.number().optional().describe("EPS for this year (overrides ROE × opening book value)"),
        payoutRatio: rate("Payout ratio this year (defaults to payoutRatio)").optional(),
        bookValueEnd: z.number().optional().describe("Stated year-end book value per share (overrides clean surplus)"),
      }),
    )
    .max(30)
    .optional()
    .describe("Multi-stage: yearly forecasts, year 1 first. Omit for the single-stage model"),
  model: z
    .enum(["single_stage", "multi_stage"])
    .optional()
    .describe("single_stage = V₀ = B₀ + (ROE − Ke)B₀/(Ke − g); multi_stage = yearly forecast (forecast rows or the *Forecast arrays). Default: multi_stage when yearly data is given"),
  roeForecast: z.array(z.number().nullable()).max(30).optional().describe("Multi-stage alternative to `forecast`: ROE per year (decimal), year 1 first"),
  epsForecast: z.array(z.number().nullable()).max(30).optional().describe("EPS per year (overrides ROE for that year)"),
  payoutForecast: z.array(z.number().nullable()).max(30).optional().describe("Payout ratio per year (decimal)"),
  bookValueForecast: z.array(z.number().nullable()).max(30).optional().describe("Stated year-end book value per share per year (null = clean surplus)"),
  terminalMethod: z
    .enum(["perpetuity", "persistence", "none"])
    .optional()
    .describe("Default perpetuity. Continuing value after the forecast (multi-stage): perpetuity RI(n+1)/(Ke−g), persistence RI(n+1)/(1+Ke−ω), or none (RI = 0)"),
  terminalRoe: rate("ROE after the forecast (defaults to the last forecast year)").optional(),
  persistence: z.number().min(0).max(1).optional().describe("ω for the persistence continuing value, default 0.6 (0 = RI disappears, 1 = no fade)"),
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

type RiAssumptions = z.infer<typeof residualIncomeSchema>;

/** Yearly rows from `forecast` and/or the parallel *Forecast arrays (array values fill gaps in the rows). */
export function riForecastRows(a: Partial<RiAssumptions>) {
  const n = Math.max(a.forecast?.length ?? 0, a.roeForecast?.length ?? 0, a.epsForecast?.length ?? 0, a.payoutForecast?.length ?? 0, a.bookValueForecast?.length ?? 0);
  const pick = (arr: (number | null)[] | undefined, i: number) => arr?.[i] ?? undefined;
  return Array.from({ length: n }, (_, i) => {
    const r = a.forecast?.[i] ?? {};
    return Object.fromEntries(
      Object.entries({
        roe: r.roe ?? pick(a.roeForecast, i),
        eps: r.eps ?? pick(a.epsForecast, i),
        payoutRatio: r.payoutRatio ?? pick(a.payoutForecast, i),
        bookValueEnd: r.bookValueEnd ?? pick(a.bookValueForecast, i),
      }).filter(([, v]) => v != null),
    ) as NonNullable<RiAssumptions["forecast"]>[number];
  });
}

/** Which residual-income model applies: explicit `model`, else multi-stage when yearly data exists. */
export function riModel(a: Partial<RiAssumptions>): "single_stage" | "multi_stage" {
  return a.model ?? (riForecastRows(a).length ? "multi_stage" : "single_stage");
}

/** Continuing value spec for the multi-stage residual-income model. */
export function riTerminal(a: { terminalMethod?: "perpetuity" | "persistence" | "none"; terminalGrowth: number; terminalRoe?: number; persistence?: number }) {
  const m = a.terminalMethod ?? "perpetuity";
  return m === "none"
    ? ({ method: "none" } as const)
    : m === "persistence"
      ? ({ method: "persistence", persistence: a.persistence ?? 0.6, roe: a.terminalRoe } as const)
      : ({ method: "perpetuity", growth: a.terminalGrowth, roe: a.terminalRoe } as const);
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
      if (riModel(a) === "multi_stage") {
        const m = multiStageResidualIncome({ bookValuePerShare: a.bookValuePerShare, ke, payoutRatio: a.payoutRatio, forecast: riForecastRows(a), terminal: riTerminal(a) });
        return {
          value: m.value,
          price: a.currentPrice,
          upside: m.value != null ? upsideOf(m.value, a.currentPrice) : null,
          details: {
            model: "multi_stage",
            costOfEquity: ke,
            years: m.years,
            pvResidualIncome: m.pvResidualIncome,
            residualIncomeNext: m.residualIncomeNext,
            terminalValue: m.terminalValue,
            pvTerminalValue: m.pvTerminalValue,
            impliedPBV: m.value != null ? m.value / a.bookValuePerShare : null,
            marketPBV: a.currentPrice / a.bookValuePerShare,
            errors: m.errors.map((message) => ({ code: "INVALID_INPUT", message })),
            warnings: m.warnings,
          },
        };
      }
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

// ------------------------------------------------------------------ multi-stage residual income tool

/**
 * Flat input for the dedicated `multi_stage_residual_income` tool, so AI clients do not have to
 * navigate the nested multi-method valuation schema. Converted to a residual_income valuation
 * with model: "multi_stage".
 */
export const multiStageRiToolInput = z.object({
  symbol: z.string().optional().describe("Stock symbol, required when save = true"),
  save: z.boolean().default(false).describe("true = also save to the Valuation page"),
  title: z.string().optional(),
  note: z.string().optional(),
  bookValuePerShare: money("Opening book value per share B₀"),
  currentPrice: money("Current share price"),
  riskFree: rate("Risk-free rate"),
  beta: z.number().describe("Equity beta"),
  equityRiskPremium: rate("Equity risk premium"),
  extraPremium: rate("Additional premium").default(0),
  payoutRatio: rate("Base payout ratio (used for years without payoutForecast)").default(0.5),
  roeForecast: z.array(z.number().nullable()).min(1).max(30).describe("ROE per year (decimal), year 1 first; null when that year uses epsForecast"),
  epsForecast: z.array(z.number().nullable()).max(30).optional().describe("EPS per year (overrides ROE for that year)"),
  payoutForecast: z.array(z.number().nullable()).max(30).optional().describe("Payout ratio per year (decimal)"),
  bookValueForecast: z.array(z.number().nullable()).max(30).optional().describe("Stated year-end book value per share; null = clean surplus"),
  terminalMethod: z.enum(["perpetuity", "persistence", "none"]).default("perpetuity").describe("Continuing value after the last year"),
  terminalGrowth: rate("Long-run growth for the perpetuity continuing value").default(0),
  terminalRoe: rate("ROE after the forecast (defaults to the last year)").optional(),
  persistence: z.number().min(0).max(1).optional().describe("ω for the persistence continuing value (default 0.6)"),
  inputMeta: inputMetaSchema,
});
export type MultiStageRiToolInput = z.infer<typeof multiStageRiToolInput>;

export function toRiValuation(x: MultiStageRiToolInput): ValuationInput {
  const { symbol: _s, save: _v, title: _t, note: _n, ...a } = x;
  // Single-stage `roe` is required by the schema but unused in multi-stage; keep the long-run ROE there for the editor.
  const lastRoe = [...a.roeForecast].reverse().find((v): v is number => v != null);
  return { method: "residual_income", assumptions: { ...a, roe: a.terminalRoe ?? lastRoe ?? 0, model: "multi_stage" } };
}

/** Evaluate (and summarize) a multi-stage residual income valuation for the AI tools. */
export function evaluateMultiStageRi(x: MultiStageRiToolInput) {
  const valuation = toRiValuation(x);
  const r = evaluate(valuation);
  const d = r.details as { years?: unknown; costOfEquity?: number; pvResidualIncome?: number; terminalValue?: number | null; pvTerminalValue?: number | null; errors?: unknown; warnings?: string[] };
  return {
    valuation,
    result: {
      model: "multi_stage",
      value: r.value,
      price: r.price,
      upside: r.upside,
      costOfEquity: d.costOfEquity,
      pvResidualIncome: d.pvResidualIncome,
      continuingValue: d.terminalValue,
      pvContinuingValue: d.pvTerminalValue,
      years: d.years,
      errors: d.errors,
      warnings: [...((r.details.sanityWarnings as string[] | undefined) ?? [])],
    },
  };
}
