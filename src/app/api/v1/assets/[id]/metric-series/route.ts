import { z } from "zod";
import { api, searchParams } from "@/server/api";
import { metricSeries } from "@/server/services/asset-metrics";

type Ctx = { params: Promise<{ id: string }> };
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const q = z.object({
  metricIds: z
    .string()
    .regex(/^\d+(,\d+){0,19}$/, "metricIds = comma-separated ids (≤ 20)")
    .optional()
    .transform((v) => (v ? v.split(",").map(Number) : undefined)),
  from: date.optional(),
  to: date.optional(),
  mode: z.enum(["actual", "indexed", "change"]).default("actual"),
});

/** GET ?metricIds=1,2&from=&to=&mode=actual|indexed|change — raw observations only; gaps stay null, nothing interpolated. */
export const GET = api<Ctx>(async (req, { params }) => metricSeries(Number((await params).id), q.parse(Object.fromEntries(searchParams(req)))));
