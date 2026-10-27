import { z } from "zod";
import { api, jsonBody, searchParams } from "@/server/api";
import { deleteDividendEvent, dividendEventInput, listDividendEvents, upsertDividendEvents } from "@/server/services/dividends";

export const GET = api(async (req) => {
  const s = searchParams(req).get("symbols");
  return listDividendEvents(s ? s.split(",").map((v) => v.trim()).filter(Boolean) : undefined);
});

/** Upsert issuer dividend events (idempotent by source + sourceEventId). Issuer data, not ledger receipts. */
export const POST = api(async (req) => upsertDividendEvents(z.object({ events: z.array(dividendEventInput).min(1).max(200) }).parse(await jsonBody(req)).events));

export const DELETE = api(async (req) => {
  const id = Number(searchParams(req).get("id"));
  if (!Number.isInteger(id) || id <= 0) throw new Error("id is required");
  return deleteDividendEvent(id);
});
