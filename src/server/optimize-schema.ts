import { z } from "zod";

const view = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("absolute"),
    symbol: z.string(),
    return: z.number().describe("Expected annual total return of the asset (decimal)"),
    confidence: z.number().gt(0).max(1).describe("0–1; 0.5 = He–Litterman ω = pτΣpᵀ, 1 = view holds exactly"),
    variance: z.number().min(0).optional().describe("Explicit view variance ω (overrides confidence)"),
  }),
  z.object({
    type: z.literal("relative"),
    long: z.array(z.string()).min(1).describe("Outperforming asset(s), equal-weighted"),
    short: z.array(z.string()).min(1).describe("Underperforming asset(s), equal-weighted"),
    return: z.number().describe("Expected annual outperformance of long over short (decimal)"),
    confidence: z.number().gt(0).max(1),
    variance: z.number().min(0).optional(),
  }),
]);

/** Black–Litterman parameters (validated only when returnMethod = black_litterman). */
export const blackLittermanInput = z.object({
  marketWeights: z
    .record(z.string(), z.number().min(0))
    .describe("Market / benchmark weights for every asset in the universe (e.g. market caps or index weights; normalized). Required — the user's holdings are never assumed to be the market"),
  marketRiskAversion: z.number().positive().optional().describe("δ in Π = δΣw; omitted → implied from the ERP setting: δ = ERP / wᵀΣw"),
  tau: z.number().gt(0).max(1).optional().describe("τ scaling the prior uncertainty (default 0.05)"),
  views: z.array(view).max(20).default([]),
  posteriorCovariance: z.boolean().optional().describe("Optimize with the posterior covariance Σ + M instead of Σ (default false)"),
});

/** Input for the Markowitz optimizer tools (MCP / REST / advisor). */
export const optimizeInput = z
  .object({
  symbols: z.array(z.string()).optional().describe("Universe; defaults to every asset with enough price history"),
  lookbackDays: z.number().int().min(90).max(3650).optional(),
  returnMethod: z.enum(["historical", "capm", "blend", "black_litterman"]).optional().describe("How expected returns are estimated (default blend). black_litterman needs blackLitterman.marketWeights"),
  blackLitterman: blackLittermanInput.optional(),
  robust: z
    .object({
      bootstrap: z.number().int().min(0).max(500).default(100).describe("Resampling draws (0 = skip)"),
      returnShock: z.number().min(0).max(0.5).default(0.02).describe("± change to each expected return for the sensitivity table (decimal)"),
      seed: z.number().int().optional(),
    })
    .optional()
    .describe("Robustness diagnostics: bootstrap weight distribution and expected-return sensitivity (same optimizer and constraints)"),
  overrides: z.record(z.string(), z.number()).optional().describe("Expected annual return overrides by symbol (decimal)"),
  objective: z.enum(["max_sharpe", "min_variance", "target_return", "target_risk", "utility"]).optional(),
  riskAversion: z.number().min(0.5).max(20).optional().describe("A in U = E[R] − ½Aσ² (2 aggressive … 10 conservative)"),
  targetReturn: z.number().optional(),
  targetRisk: z.number().optional(),
  minWeight: z.number().min(0).max(1).optional(),
  maxWeight: z.number().min(0).max(1).optional(),
  useRiskFree: z.boolean().optional().describe("Mix the tangency portfolio with the risk-free asset (complete portfolio y*)"),
  extraCash: z.number().min(0).optional().describe("Extra THB to invest on top of current holdings"),
  covMethod: z.enum(["sample", "ledoit_wolf"]).optional().describe("Covariance estimator (default sample; ledoit_wolf shrinks toward a scaled identity)"),
  })
  .refine((v) => (v.minWeight ?? 0) <= (v.maxWeight ?? 1), { message: "minWeight must not exceed maxWeight" })
  .refine((v) => v.returnMethod !== "black_litterman" || v.blackLitterman, { message: "returnMethod black_litterman requires blackLitterman.marketWeights", path: ["blackLitterman"] });
