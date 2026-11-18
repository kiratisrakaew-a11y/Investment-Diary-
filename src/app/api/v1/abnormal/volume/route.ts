import { z } from "zod";
import { api, searchParams } from "@/server/api";
import { getAbnormalVolume } from "@/server/services/abnormal";
import { rangeQuery, thresholdsOf } from "../params";

const q = rangeQuery.extend({ symbol: z.string().trim().min(1).max(40) });

/** GET ?symbol=PLANB&from=&to= — same as MCP get_abnormal_volume (with every day). */
export const GET = api(async (req) => {
  const x = q.parse(Object.fromEntries(searchParams(req)));
  return getAbnormalVolume({ ...x, thresholds: thresholdsOf(x) });
});
