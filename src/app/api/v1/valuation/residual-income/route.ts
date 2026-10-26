import { api, jsonBody } from "@/server/api";
import { multiStageResidualIncome } from "@/server/services/valuations";

/** Multi-stage residual income (yearly ROE / book value forecasts); saves when `save` is true. */
export const POST = api(async (req) => multiStageResidualIncome(await jsonBody(req), "chatgpt"));
