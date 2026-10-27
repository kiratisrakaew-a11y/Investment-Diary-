import { api, jsonBody } from "@/server/api";
import { getDividendIncome } from "@/server/services/strategies";

/** Dividend income plan for current holdings. Read-only; never records receipts. */
export const GET = api(async () => getDividendIncome());
export const POST = api(async (req) => getDividendIncome(await jsonBody(req)));
