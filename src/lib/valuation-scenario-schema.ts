/**
 * Schemas for the cross-method scenario layer (PR11–PR15). Kept free of model imports so the
 * valuation schemas can embed `scenarioSetSchema` without an import cycle; the engine that runs
 * them lives in `valuation-scenarios.ts` and calls the existing evaluator.
 *
 * Overrides are addressed by a path, never by array index alone for SOTP segments:
 *   growthStart · stages[high].capexPct · segments[COM7].source.price · segments[core].model.terminalGrowth
 *   segments[core].scenario = "Bear" (apply that segment's own named scenario) · nonOperatingAssets[Land].value
 */
import { z } from "zod";

export const overrideValue = z.union([z.number(), z.string().max(60)]);

export const valuationScenarioSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, "id ใช้ได้เฉพาะ A–Z a–z 0–9 _ -")
    .describe("Stable scenario id, e.g. bear / base / bull"),
  name: z.string().min(1).max(60).describe("Bear, Base, Bull or a custom name"),
  probability: z.number().describe("Decimal 0..1; all scenarios must sum to 1 within 1e-8"),
  inputOverrides: z.record(z.string().max(160), overrideValue).default({}).describe("Path → value, allow-listed per method (see SCENARIO_PATHS)"),
  rationale: z.string().max(2000).optional().describe("Why these assumptions (user assumption, not observed data)"),
  sources: z.string().max(2000).optional().describe("Sources for scenario-specific inputs (net debt, ownership, FX …) with dates"),
  noteTh: z.string().max(12000).optional().describe("Analyst-edited Thai note; never overwritten by regeneration"),
});
export type ValuationScenario = z.infer<typeof valuationScenarioSchema>;

const axis = z.object({
  path: z.string().min(1).max(160),
  mode: z.enum(["shift", "absolute", "pct"]).default("shift").describe("shift = base + v; absolute = v; pct = base × (1 + v)"),
  values: z.array(z.number()).min(1).max(11),
});
export type SensitivityAxisSpec = z.infer<typeof axis>;

export const sensitivityConfigSchema = z.object({ x: axis, y: axis.optional() });
export type SensitivityConfig = z.infer<typeof sensitivityConfigSchema>;

export const reverseConfigSchema = z.object({
  path: z.string().min(1).max(160).describe("Single driver to solve, e.g. growthShift, terminalGrowth, discountRate, segments[core].model.growthShift"),
  lo: z.number(),
  hi: z.number(),
  targetPrice: z.number().positive().optional().describe("Default: the current market price in the inputs"),
});
export type ReverseConfig = z.infer<typeof reverseConfigSchema>;

const distribution = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uniform"), min: z.number(), max: z.number() }),
  z.object({ type: z.literal("triangular"), min: z.number(), mode: z.number(), max: z.number() }),
  z.object({ type: z.literal("normal"), mean: z.number(), sd: z.number().positive(), min: z.number().optional(), max: z.number().optional() }).describe("Truncated to [min, max] when given"),
  z.object({ type: z.literal("empirical"), samples: z.array(z.number()).min(20).max(5000), source: z.string().min(1).describe("Where the observed samples come from — required") }),
]);
export type DistributionSpec = z.infer<typeof distribution>;

export const MC_MAX_DRAWS = 10_000;
export const monteCarloConfigSchema = z.object({
  seed: z.number().int().min(0).max(2 ** 31 - 1).default(20261027),
  draws: z.number().int().min(100).max(MC_MAX_DRAWS).default(2000),
  variables: z
    .array(z.object({ path: z.string().min(1).max(160), mode: z.enum(["shift", "absolute"]).default("absolute"), dist: distribution }))
    .min(1)
    .max(8),
  correlation: z.array(z.array(z.number().min(-1).max(1))).optional().describe("Rank-free Gaussian-copula correlation, one row per variable"),
  maxInvalidShare: z.number().min(0).max(0.5).default(0.2),
  timeBudgetMs: z.number().int().min(100).max(20_000).default(8000),
});
export type MonteCarloConfig = z.infer<typeof monteCarloConfigSchema>;

export const scenarioSetSchema = z
  .object({
    version: z.literal(1).default(1),
    mode: z.enum(["custom", "from_segments"]).default("custom").describe("from_segments (SOTP): one scenario per name shared by the segment models' own scenarios"),
    scenarios: z.array(valuationScenarioSchema).max(8).default([]),
    sensitivity: sensitivityConfigSchema.optional(),
    reverse: reverseConfigSchema.optional(),
    monteCarlo: monteCarloConfigSchema.optional().describe("Opt-in; saved as configuration + summary, never raw draws"),
  })
  .optional()
  .describe("Cross-method scenarios (PR11). Base value stays the unmodified inputs; the weighted value is reported separately");
export type ScenarioSet = NonNullable<z.infer<typeof scenarioSetSchema>>;
