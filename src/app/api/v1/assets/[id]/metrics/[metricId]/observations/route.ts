import { api, jsonBody, searchParams } from "@/server/api";
import { addObservation, listObservations } from "@/server/services/asset-metrics";

type Ctx = { params: Promise<{ id: string; metricId: string }> };

/** GET ?from=&to=&limit=&offset= → newest first, each with the status under the rule in effect on its date. */
export const GET = api<Ctx>(async (req, { params }) => {
  const p = await params;
  return listObservations(Number(p.id), Number(p.metricId), Object.fromEntries(searchParams(req)));
});

/** POST { observedOn, value, source?, note?, publishedOn? } → 201; 409 DUPLICATE_OBSERVATION for an existing date. */
export const POST = api<Ctx>(async (req, { params }) => {
  const p = await params;
  return Response.json(await addObservation(Number(p.id), Number(p.metricId), await jsonBody(req, 16_384), "api"), { status: 201 });
});
