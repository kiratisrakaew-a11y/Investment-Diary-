import { api, jsonBody } from "@/server/api";
import { screenDividendStocks } from "@/server/services/strategies";

/** Dividend screener (same service as the web page, MCP and advisor). Read-only. */
export const POST = api(async (req) => screenDividendStocks(await jsonBody(req)));
