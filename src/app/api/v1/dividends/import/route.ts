import { api, jsonBody } from "@/server/api";
import { importDividendsFromYahoo } from "@/server/services/dividends";

export const maxDuration = 120;

/** Store Yahoo dividend history as issuer events (no prices, no ledger writes). */
export const POST = api(async (req) => importDividendsFromYahoo(await jsonBody(req).catch(() => ({}))));
