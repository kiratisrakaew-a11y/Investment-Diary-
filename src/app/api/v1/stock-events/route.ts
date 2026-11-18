import { z } from "zod";
import { api, jsonBody, searchParams } from "@/server/api";
import {
  EVENT_TYPES,
  listEvents,
  recordEvent,
} from "@/server/services/stock-data";
import { date } from "../abnormal/params";

const q = z.object({
  symbol: z.string().trim().min(1).max(40),
  from: date.optional(),
  to: date.optional(),
  types: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",") : undefined))
    .pipe(z.array(z.enum(EVENT_TYPES)).optional()),
});

/** GET ?symbol=PLANB[&types=news,earnings] — events newest first (XD from dividend data included, id null). */
export const GET = api(async (req) => ({
  events: await listEvents(q.parse(Object.fromEntries(searchParams(req)))),
}));

/** POST { symbol, eventDate, eventType, description, source } */
export const POST = api(async (req) => recordEvent(await jsonBody(req)));
