import { api, jsonBody } from "@/server/api";
import { bondSchema, evaluate } from "@/lib/valuation-schemas";

export const POST = api(async (req) => evaluate({ method: "bond", assumptions: bondSchema.parse(await jsonBody(req)) }));
