import { api, jsonBody } from "@/server/api";
import { deleteObservation, updateObservation } from "@/server/services/asset-metrics";

type Ctx = { params: Promise<{ id: string; metricId: string; observationId: string }> };

export const PATCH = api<Ctx>(async (req, { params }) => {
  const p = await params;
  return updateObservation(Number(p.id), Number(p.metricId), Number(p.observationId), await jsonBody(req, 16_384), "api");
});

export const DELETE = api<Ctx>(async (_req, { params }) => {
  const p = await params;
  return deleteObservation(Number(p.id), Number(p.metricId), Number(p.observationId), "api");
});
