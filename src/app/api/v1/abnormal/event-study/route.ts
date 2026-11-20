import { z } from "zod";
import { api, searchParams } from "@/server/api";
import { runEventStudy } from "@/server/services/abnormal";
import { date, windowParam } from "../params";

const q = z.object({
  symbol: z.string().trim().min(1).max(40),
  eventDate: date.optional(),
  eventId: z.coerce.number().int().positive().optional(),
  model: z.enum(["market", "dimson", "market_adjusted"]).default("market"),
  estimationWindow: windowParam.optional(),
  eventWindow: windowParam.optional(),
  triSymbol: z.string().trim().min(1).max(40).optional(),
  returnBasis: z.enum(["auto", "price_return", "total_return"]).optional(),
  benchmark: z.string().trim().min(1).max(40).optional(),
});

/** GET ?symbol=PLANB&eventDate=2026-05-01&model=market — same as MCP run_event_study. */
export const GET = api(async (req) =>
  runEventStudy(q.parse(Object.fromEntries(searchParams(req)))),
);
