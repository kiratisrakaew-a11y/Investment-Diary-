/**
 * PR15 — one entry point for the optional analyses (scenarios, sensitivity, reverse DCF, Monte Carlo)
 * shared by the editor, REST, MCP and save. Deterministic results never depend on Monte Carlo: a
 * failing simulation returns a typed partial result.
 */
import { z } from "zod";
import { valuationInput, type ValuationInput } from "./valuation-schemas";
import { runScenarios, type ScenarioSummary } from "./valuation-scenarios";
import { defaultReverse, defaultSensitivity, reverseSolve, sensitivityGrid, type ReverseResult, type SensitivityResult } from "./valuation-analytics";
import { monteCarlo, type MonteCarloResult } from "./valuation-montecarlo";
import { monteCarloConfigSchema, reverseConfigSchema, sensitivityConfigSchema, valuationScenarioSchema, type ScenarioSet } from "./valuation-scenario-schema";
import { generateScenarioNoteTh, inputHash } from "./valuation-notes-th";
import { MODEL_VERSION } from "./governance";

export const analyzeRequest = z.object({
  valuation: valuationInput,
  scenarios: z.array(valuationScenarioSchema).max(8).optional().describe("Run these instead of valuation.assumptions.scenarioSet.scenarios"),
  sensitivity: z.union([z.literal("default"), sensitivityConfigSchema]).optional(),
  reverse: z.union([z.literal("default"), reverseConfigSchema]).optional(),
  monteCarlo: z.union([z.literal("saved"), monteCarloConfigSchema]).optional().describe("'saved' = the config stored in scenarioSet.monteCarlo"),
  currency: z.string().max(8).optional(),
});
export type AnalyzeRequest = z.input<typeof analyzeRequest>;

export interface AnalyzeResult {
  method: ValuationInput["method"];
  modelVersion: string;
  inputHash: string;
  scenarioAnalysis: ScenarioSummary | null;
  /** Generated Thai explanation per scenario id (the analyst's own noteTh is in scenarioAnalysis.scenarios[].noteTh). */
  generatedNotesTh: Record<string, string>;
  sensitivity: SensitivityResult | { unsupported: string } | null;
  reverse: ReverseResult | { unsupported: string } | null;
  monteCarlo: MonteCarloResult | { error: string } | null;
}

export function hasScenarios(input: ValuationInput) {
  const set = (input.assumptions as { scenarioSet?: ScenarioSet }).scenarioSet;
  return !!set && (set.scenarios.length > 0 || set.mode === "from_segments");
}

export function analyzeValuation(req: z.output<typeof analyzeRequest>, opts: { today?: string } = {}): AnalyzeResult {
  const input = req.valuation;
  const set = (input.assumptions as { scenarioSet?: ScenarioSet }).scenarioSet;
  const scen = req.scenarios || hasScenarios(input) ? runScenarios(input, { scenarios: req.scenarios, currency: req.currency, today: opts.today }) : null;
  const notes = scen ? Object.fromEntries(scen.scenarios.map((s) => [s.scenarioId, generateScenarioNoteTh(input, scen, s)])) : {};
  let sens: AnalyzeResult["sensitivity"] = null;
  if (req.sensitivity) {
    const cfg = req.sensitivity === "default" ? defaultSensitivity(input) : req.sensitivity;
    sens = "unsupported" in cfg ? cfg : sensitivityGrid(input, cfg);
  }
  let rev: AnalyzeResult["reverse"] = null;
  if (req.reverse) {
    const cfg = req.reverse === "default" ? defaultReverse(input) : req.reverse;
    rev = "unsupported" in cfg ? cfg : reverseSolve(input, cfg);
  }
  let mc: AnalyzeResult["monteCarlo"] = null;
  if (req.monteCarlo) {
    const cfg = req.monteCarlo === "saved" ? set?.monteCarlo : req.monteCarlo;
    if (!cfg) mc = { error: "ยังไม่มีการตั้งค่า Monte Carlo ที่บันทึกไว้" };
    else
      try {
        mc = monteCarlo(input, cfg);
      } catch (e) {
        mc = { error: `Monte Carlo ล้มเหลว (ผลกำหนดแน่นอนยังใช้ได้): ${e instanceof Error ? e.message : String(e)}` };
      }
  }
  return { method: input.method, modelVersion: MODEL_VERSION, inputHash: inputHash(input.assumptions), scenarioAnalysis: scen, generatedNotesTh: notes, sensitivity: sens, reverse: rev, monteCarlo: mc };
}

/** Compact snapshot stored in valuations.result on save (no raw draws, no grids). */
export function scenarioSnapshot(r: AnalyzeResult, savedAt: string) {
  const s = r.scenarioAnalysis;
  return {
    inputHash: r.inputHash,
    savedAt,
    ...(s
      ? {
          scenarioAnalysis: {
            baseCaseValue: s.baseCaseValue,
            probabilityWeightedValue: s.probabilityWeightedValue,
            sumProbability: s.sumProbability,
            valueKind: s.valueKind,
            qualityStatus: s.qualityStatus,
            qualityReasons: s.qualityReasons,
            currency: s.currency,
            asOf: s.asOf,
            modelVersion: s.modelVersion,
            derivedFromSegments: s.derivedFromSegments,
            errors: s.errors,
            scenarios: s.scenarios.map((x) => ({
              id: x.scenarioId,
              name: x.name,
              probability: x.probability,
              value: x.valuePerShare,
              equityValue: x.equityValue,
              upside: x.upsidePct,
              marginOfSafety: x.marginOfSafetyPct,
              inputsResolved: x.inputsResolved,
              warnings: x.warnings,
              errors: x.errors,
              generatedNoteTh: r.generatedNotesTh[x.scenarioId] ?? null,
            })),
          },
        }
      : {}),
    ...(r.monteCarlo ? { monteCarlo: r.monteCarlo } : {}),
  };
}
