import { api, jsonBody } from "@/server/api";
import { syncHistoricalPrices } from "@/server/services/price-sync";

export const maxDuration = 60;

/** Historical price backfill / date-range sync for existing assets (see sync_historical_prices). */
export const POST = api(async (req) => syncHistoricalPrices(await jsonBody(req)));
