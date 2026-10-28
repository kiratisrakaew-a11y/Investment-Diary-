import { api, jsonBody, searchParams } from "@/server/api";
import { createMetric, metricsOverview } from "@/server/services/asset-metrics";

type Ctx = { params: Promise<{ id: string }> };
const LIMIT = 16_384;

/** GET: metric definitions with latest observation, status (rule in effect on that date), freshness and thresholds. ?includeInactive=1, ?observations=1 */
export const GET = api<Ctx>(async (req, { params }) => {
  const sp = searchParams(req);
  return metricsOverview(Number((await params).id), { includeInactive: sp.get("includeInactive") === "1", withObservations: sp.get("observations") === "1" });
});

/** POST { name, unit, description?, frequency?, decimals?, chartColor?, sourceDefault? } → 201 definition; 409 when the normalised key exists. */
export const POST = api<Ctx>(async (req, { params }) => Response.json(await createMetric(Number((await params).id), await jsonBody(req, LIMIT), "api"), { status: 201 }));
