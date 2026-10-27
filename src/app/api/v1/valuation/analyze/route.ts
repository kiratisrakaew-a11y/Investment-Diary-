import { api, jsonBody } from "@/server/api";
import { analyzeRequest, analyzeValuation } from "@/lib/valuation-analyze";

/** Scenarios, sensitivity, reverse DCF and Monte Carlo on the same evaluator as /evaluate. */
export const POST = api(async (req) => analyzeValuation(analyzeRequest.parse(await jsonBody(req))));
