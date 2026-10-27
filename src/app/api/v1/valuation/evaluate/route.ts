import { api, jsonBody } from "@/server/api";
import { evaluate, valuationInput } from "@/lib/valuation-schemas";
import { analyzeValuation, hasScenarios } from "@/lib/valuation-analyze";

export const POST = api(async (req) => {
  const v = valuationInput.parse(await jsonBody(req));
  const r = evaluate(v);
  // Same contract as before; scenarioAnalysis is added only when the input carries a scenarioSet.
  return hasScenarios(v) ? { ...r, scenarioAnalysis: analyzeValuation({ valuation: v }).scenarioAnalysis } : r;
});
