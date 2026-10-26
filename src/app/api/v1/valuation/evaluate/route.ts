import { api, jsonBody } from "@/server/api";
import { evaluate, valuationInput } from "@/lib/valuation-schemas";

export const POST = api(async (req) => evaluate(valuationInput.parse(await jsonBody(req))));
