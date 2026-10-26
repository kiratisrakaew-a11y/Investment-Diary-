import { z } from "zod";

/** Input for the Markowitz optimizer tools (MCP / REST / advisor). */
export const optimizeInput = z.object({
  symbols: z.array(z.string()).optional().describe("Universe; defaults to every asset with enough price history"),
  lookbackDays: z.number().int().min(90).max(3650).optional(),
  returnMethod: z.enum(["historical", "capm", "blend"]).optional().describe("How expected returns are estimated (default blend)"),
  overrides: z.record(z.string(), z.number()).optional().describe("Expected annual return overrides by symbol (decimal)"),
  objective: z.enum(["max_sharpe", "min_variance", "target_return", "target_risk", "utility"]).optional(),
  riskAversion: z.number().min(0.5).max(20).optional().describe("A in U = E[R] − ½Aσ² (2 aggressive … 10 conservative)"),
  targetReturn: z.number().optional(),
  targetRisk: z.number().optional(),
  minWeight: z.number().min(0).max(1).optional(),
  maxWeight: z.number().min(0).max(1).optional(),
  useRiskFree: z.boolean().optional().describe("Mix the tangency portfolio with the risk-free asset (complete portfolio y*)"),
  extraCash: z.number().min(0).optional().describe("Extra THB to invest on top of current holdings"),
});
