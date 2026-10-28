import { api, jsonBody, searchParams } from "@/server/api";
import { deleteMetric, updateMetric } from "@/server/services/asset-metrics";

type Ctx = { params: Promise<{ id: string; metricId: string }> };

/** PATCH metadata / { isActive:false } soft archive / { showInChart } — unit change with data needs confirmUnitChange. */
export const PATCH = api<Ctx>(async (req, { params }) => {
  const p = await params;
  return updateMetric(Number(p.id), Number(p.metricId), await jsonBody(req, 16_384), "api");
});

/** DELETE ?confirmName=<exact metric name> — removes the metric with its observations and thresholds (audited). */
export const DELETE = api<Ctx>(async (req, { params }) => {
  const p = await params;
  return deleteMetric(Number(p.id), Number(p.metricId), searchParams(req).get("confirmName") ?? "", "api");
});
