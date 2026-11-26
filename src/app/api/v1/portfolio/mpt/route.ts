import { z } from "zod";
import { api, searchParams } from "@/server/api";
import { getMptAnalysis } from "@/server/services/portfolio";
import { returnBasisField } from "@/server/basis-schema";
import { windowFromQuery } from "@/lib/finance/window";

const q = z.object({
  returnBasis: returnBasisField,
  frequency: z.enum(["daily", "weekly", "monthly"]).optional(),
  historyPolicy: z.enum(["common", "drop_short", "pairwise"]).optional(),
  covMethod: z.enum(["sample", "ledoit_wolf"]).optional(),
});

/** GET ?returnBasis=&window=3y|custom&startDate=&endDate=&frequency=&historyPolicy=&covMethod= */
export const GET = api(async (req) => {
  const sp = searchParams(req);
  const x = q.parse(Object.fromEntries([...sp].filter(([k]) => ["returnBasis", "frequency", "historyPolicy", "covMethod"].includes(k))));
  const r = await getMptAnalysis(undefined, undefined, { ...x, window: windowFromQuery(sp) });
  if (!r.ok) return r;
  const { cloud: _c, frontier: _f, ...rest } = r;
  return rest;
});
