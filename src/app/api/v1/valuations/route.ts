import { api, jsonBody, searchParams } from "@/server/api";
import { listValuations, saveValuation } from "@/server/services/valuations";

export const GET = api(async (req) => listValuations({ symbol: searchParams(req).get("symbol") ?? undefined, limit: 100 }));
export const POST = api(async (req) => saveValuation({ source: "api", ...(await jsonBody(req)) }));
