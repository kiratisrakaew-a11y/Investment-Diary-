import { api, jsonBody, searchParams } from "@/server/api";
import { addThresholdVersion, listThresholds, previewThreshold } from "@/server/services/asset-metrics";

type Ctx = { params: Promise<{ id: string; metricId: string }> };

/** GET: threshold version history (effectiveFrom ≤ date < effectiveTo). */
export const GET = api<Ctx>(async (_req, { params }) => {
  const p = await params;
  return listThresholds(Number(p.id), Number(p.metricId));
});

/** POST a new effective-dated version (?preview=1 → impact on observations only, nothing saved). 409 on overlap / backdating. */
export const POST = api<Ctx>(async (req, { params }) => {
  const p = await params;
  const body = await jsonBody(req, 16_384);
  if (searchParams(req).get("preview") === "1") return previewThreshold(Number(p.id), Number(p.metricId), body);
  return Response.json(await addThresholdVersion(Number(p.id), Number(p.metricId), body, "api"), { status: 201 });
});
