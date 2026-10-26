import { api, jsonBody } from "@/server/api";
import { optimizeInput } from "@/server/optimize-schema";
import { optimizePortfolio } from "@/server/services/optimizer";

export const POST = api(async (req) => optimizePortfolio(optimizeInput.parse(await jsonBody(req))));
