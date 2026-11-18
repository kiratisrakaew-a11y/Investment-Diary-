import { z } from "zod";
import { api, jsonBody, searchParams } from "@/server/api";
import {
  setSharesOutstanding,
  sharesHistory,
} from "@/server/services/stock-data";

/** GET ?symbol=PLANB — every recorded share count, oldest first. */
export const GET = api(async (req) => {
  const { symbol } = z
    .object({ symbol: z.string().trim().min(1).max(40) })
    .parse(Object.fromEntries(searchParams(req)));
  return { symbol: symbol.toUpperCase(), history: await sharesHistory(symbol) };
});

/** POST { symbol, effectiveDate, shares, source, note? } — source required; never estimated. */
export const POST = api(async (req) =>
  setSharesOutstanding(await jsonBody(req)),
);
