import { z } from "zod";
import { api, searchParams } from "@/server/api";
import { scanAbnormalTrading } from "@/server/services/abnormal";
import { rangeQuery, thresholdsOf } from "../params";

const q = rangeQuery.extend({
  symbols: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    ),
  eventHorizon: z.coerce.number().int().min(1).max(60).optional(),
  triSymbol: z.string().trim().min(1).max(40).optional(),
  returnBasis: z.enum(["auto", "price_return", "total_return"]).optional(),
  benchmark: z.string().trim().min(1).max(40).optional(),
});

/** GET ?symbols=PLANB,PTT&from=&to=&notable=&abnormal= — same as MCP scan_abnormal_trading. */
export const GET = api(async (req) => {
  const x = q.parse(Object.fromEntries(searchParams(req)));
  return scanAbnormalTrading({ ...x, thresholds: thresholdsOf(x) });
});
