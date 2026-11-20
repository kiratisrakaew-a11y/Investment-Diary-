import { z } from "zod";
import { benchmarkField } from "./basis-schema";
import { constraintsInput } from "@/lib/finance/exposure";
import { shortPolicyInput } from "@/lib/finance/short-policy";

const view = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("absolute"),
    symbol: z.string(),
    return: z
      .number()
      .describe("Expected annual total return of the asset (decimal)"),
    confidence: z
      .number()
      .gt(0)
      .max(1)
      .describe("0–1; 0.5 = He–Litterman ω = pτΣpᵀ, 1 = view holds exactly"),
    variance: z
      .number()
      .min(0)
      .optional()
      .describe("Explicit view variance ω (overrides confidence)"),
  }),
  z.object({
    type: z.literal("relative"),
    long: z
      .array(z.string())
      .min(1)
      .describe("Outperforming asset(s), equal-weighted"),
    short: z
      .array(z.string())
      .min(1)
      .describe("Underperforming asset(s), equal-weighted"),
    return: z
      .number()
      .describe("Expected annual outperformance of long over short (decimal)"),
    confidence: z.number().gt(0).max(1),
    variance: z.number().min(0).optional(),
  }),
]);

/** Black–Litterman parameters (validated only when returnMethod = black_litterman). */
export const blackLittermanInput = z.object({
  marketWeights: z
    .record(z.string(), z.number().min(0))
    .describe(
      "Market / benchmark weights for every asset in the universe (e.g. market caps or index weights; normalized). Required — the user's holdings are never assumed to be the market",
    ),
  marketRiskAversion: z
    .number()
    .positive()
    .optional()
    .describe(
      "δ in Π = δΣw; omitted → implied from the ERP setting: δ = ERP / wᵀΣw",
    ),
  tau: z
    .number()
    .gt(0)
    .max(1)
    .optional()
    .describe("τ scaling the prior uncertainty (default 0.05)"),
  views: z.array(view).max(20).default([]),
  viewsFromValuations: z
    .boolean()
    .optional()
    .describe(
      "Add absolute views from saved valuations (latest per method, median fair value; view = FV / latest price − 1, plus trailing dividend yield on total_return; confidence from the bear–bull scenario width or the spread between methods). Valuations older than valuationMaxAgeDays are skipped with a warning. In a backtest only valuations saved before each rebalance are used",
    ),
  valuationMaxAgeDays: z.number().int().min(1).max(730).optional().describe("Default 90"),
  posteriorCovariance: z
    .boolean()
    .optional()
    .describe(
      "Optimize with the posterior covariance Σ + M instead of Σ (default false)",
    ),
});

/** Input for the Markowitz optimizer tools (MCP / REST / advisor). */
/** Default μ estimator for every tool (optimize, backtest, compare): one place, so the tools agree. */
export const DEFAULT_RETURN_METHOD = "blend" as const;

/** Risk-free resolver options shared by optimize / compare / backtest (same resolver, riskFreeInfo returned). */
export const riskFreeInput = z
  .object({
    source: z
      .enum(["auto", "curve", "settings", "manual"])
      .optional()
      .describe(
        "auto (default) = currency-matched sovereign zero curve at the horizon, else the Settings rate; never an owned bond's YTM",
      ),
    horizonYears: z
      .number()
      .positive()
      .max(50)
      .optional()
      .describe(
        "Tenor for the curve (default 1 year for portfolio Sharpe / CAL)",
      ),
    currency: z.string().length(3).optional(),
    manual: z
      .object({
        rate: z.number().min(-0.05).max(0.5),
        reason: z.string().min(3).max(300),
      })
      .optional()
      .describe("source manual: decimal rate + reason (audit trail)"),
  })
  .optional()
  .describe(
    "Risk-free rate resolver options; the result and its provenance are returned as riskFreeInfo",
  );

export const optimizeInput = z
  .object({
    symbols: z
      .array(z.string())
      .optional()
      .describe("Universe; defaults to every asset with enough price history"),
    lookbackDays: z.number().int().min(90).max(3650).optional(),
    returnBasis: z
      .enum(["price_return", "total_return"])
      .optional()
      .describe(
        "Return series for μ/Σ: price_return (closes) or total_return per asset (returnBasisByAsset): adj_close when complete; gold, accumulating funds (NAV) and stocks without dividends / splits in the period use their close (already their total return); a stock that paid dividends without full adj_close is skipped with the reason. Omit = Settings default (price_return unless changed). The result's priceBasis says what was used",
      ),
    benchmark: benchmarkField.describe(
      'Index for β / CAPM expected returns: "default" = Settings\' index (as before; warns when its kind does not match the basis), "auto" = TRI for total_return / price index for price_return, or a stored index symbol (SETTRI, ^SET.BK …). Omit = Settings default. The result\'s benchmark says which index and kind were used',
    ),
    returnMethod: z
      .enum(["historical", "capm", "blend", "shrinkage", "black_litterman"])
      .optional()
      .describe(
        "How expected returns are estimated (default blend). blend = w·historical + (1 − w)·CAPM with w = 0.5·min(1, years/3) — under 3 years of data CAPM weighs more (stated in warnings); shrinkage = Bayes–Stein toward CAPM; Settings muCapPct caps |μ − CAPM| for history-based methods (before / after in warnings). black_litterman needs blackLitterman.marketWeights (optionally viewsFromValuations)",
      ),
    blackLitterman: blackLittermanInput.optional(),
    constraints: constraintsInput.optional(),
    robust: z
      .object({
        bootstrap: z
          .number()
          .int()
          .min(0)
          .max(500)
          .default(100)
          .describe("Resampling draws (0 = skip)"),
        returnShock: z
          .number()
          .min(0)
          .max(0.5)
          .default(0.02)
          .describe(
            "± change to each expected return for the sensitivity table (decimal)",
          ),
        seed: z.number().int().optional(),
      })
      .optional()
      .describe(
        "Robustness diagnostics: bootstrap weight distribution and expected-return sensitivity (same optimizer and constraints)",
      ),
    overrides: z
      .record(z.string(), z.number())
      .optional()
      .describe("Expected annual return overrides by symbol (decimal)"),
    objective: z
      .enum([
        "max_sharpe",
        "min_variance",
        "target_return",
        "target_risk",
        "utility",
        "risk_parity",
        "max_diversification",
        "min_cvar",
      ])
      .optional()
      .describe(
        "risk_parity = equal (or budgeted) risk contributions; max_diversification = max Σwσ/σ_p; min_cvar = minimum historical CVaR (LP). Risk-based objectives do not use expected returns",
      ),
    riskBudgets: z
      .record(z.string(), z.number().positive())
      .optional()
      .describe(
        "risk_parity: risk budget per symbol (normalized); default equal",
      ),
    cvarConfidence: z
      .number()
      .min(0.8)
      .max(0.995)
      .optional()
      .describe("min_cvar confidence (default 0.95)"),
    riskAversion: z
      .number()
      .min(0.5)
      .max(20)
      .optional()
      .describe("A in U = E[R] − ½Aσ² (2 aggressive … 10 conservative)"),
    targetReturn: z.number().optional(),
    targetRisk: z.number().optional(),
    minWeight: z
      .number()
      .min(-1)
      .max(1)
      .optional()
      .describe(
        "Minimum weight per asset; below 0 only with allowShortSelling (otherwise rejected with SHORT_SELLING_DISABLED)",
      ),
    maxWeight: z.number().min(0).max(1).optional(),
    useRiskFree: z
      .boolean()
      .optional()
      .describe(
        "Mix the tangency portfolio with the risk-free asset (complete portfolio y*)",
      ),
    extraCash: z
      .number()
      .min(0)
      .optional()
      .describe("Extra THB to invest on top of current holdings"),
    covMethod: z
      .enum(["sample", "ledoit_wolf"])
      .optional()
      .describe(
        "Covariance estimator (default sample; ledoit_wolf shrinks toward a scaled identity)",
      ),
    frequency: z
      .enum(["daily", "weekly", "monthly"])
      .optional()
      .describe(
        "Return sampling on the common calendar: daily or the last actual observation per week / month (no fill); annualization uses the observed periods per year. Omitted = daily, or weekly when the universe mixes Thai-market closes with US-time closes (USD assets, world gold) — stated in a note",
      ),
    dividendWithholding: z
      .number()
      .min(0)
      .max(0.5)
      .optional()
      .describe(
        "With returnBasis total_return: measure stocks on closes + cash dividends × (1 − rate) — net of withholding tax (Thai individuals: 0.10) — instead of the provider's gross adjusted closes; an event's own withholdingTaxRate wins. returnBasisByAsset shows net_dividends",
      ),
    historyPolicy: z
      .enum(["common", "drop_short", "pairwise"])
      .optional()
      .describe(
        "common (default) = one common calendar (a short-history asset shortens it — the warning names it and its first date); drop_short = leave out assets whose history starts after the look-back start (listed in skipped); pairwise = covariance from each pair's own overlap made positive semidefinite, μ from each asset's own window",
      ),
    bondReturnMethod: z
      .enum(["same_as_other", "yield_horizon"])
      .optional()
      .describe(
        "Bonds: same estimator as other assets (default) or forward horizon return from YTM (carry + pull-to-par, rolldown on the curve, optional rate shift, minus PD×LGD when given)",
      ),
    bondHorizonYears: z
      .number()
      .positive()
      .max(30)
      .optional()
      .describe(
        "Horizon for yield_horizon (default 1 year; capped at maturity)",
      ),
    bondRateShiftBp: z
      .number()
      .min(-500)
      .max(500)
      .optional()
      .describe(
        "Parallel yield shift scenario in bp for yield_horizon (default 0)",
      ),
    ...shortPolicyInput.partial().shape,
    riskFree: riskFreeInput,
  })
  .refine((v) => (v.minWeight ?? 0) <= (v.maxWeight ?? 1), {
    message: "minWeight must not exceed maxWeight",
  })
  .refine((v) => v.returnMethod !== "black_litterman" || v.blackLitterman, {
    message:
      "returnMethod black_litterman requires blackLitterman.marketWeights",
    path: ["blackLitterman"],
  });
