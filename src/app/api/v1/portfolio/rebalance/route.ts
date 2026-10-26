import { api, jsonBody } from "@/server/api";
import { rebalancePortfolio } from "@/server/services/rebalance";

/** Proposed trades only — never records transactions. */
export const POST = api(async (req) => rebalancePortfolio((await jsonBody(req)) as never));
