import { api, jsonBody } from "@/server/api";
import { screenFactorStocks } from "@/server/services/strategies";

/** Value / quality / momentum / multi-factor screen (same service as the web page, MCP and advisor). */
export const POST = api(async (req) => screenFactorStocks(await jsonBody(req)));
