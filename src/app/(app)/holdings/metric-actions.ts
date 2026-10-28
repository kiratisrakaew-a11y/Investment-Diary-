"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import {
  MetricError,
  addObservation,
  addThresholdVersion,
  createMetric,
  deleteMetric,
  deleteObservation,
  previewThreshold,
  updateMetric,
  updateObservation,
} from "@/server/services/asset-metrics";
import type { MetricDefinitionInput, ObservationInput, ThresholdInput } from "@/lib/asset-metrics/schemas";

export type MetricActionResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string; code?: string; detail?: unknown };

async function run<T>(assetId: number, fn: () => Promise<T>, revalidate = true): Promise<MetricActionResult<T>> {
  try {
    const data = await fn();
    // Only this asset's page: no portfolio-wide refetch.
    if (revalidate) revalidatePath(`/holdings/${assetId}`);
    return { ok: true, data: JSON.parse(JSON.stringify(data)) as T };
  } catch (e) {
    if (e instanceof MetricError) return { ok: false, error: e.message, code: e.code, detail: e.detail };
    if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => i.message).join(" · "), code: "INVALID_INPUT" };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function createMetricAction(assetId: number, input: MetricDefinitionInput) {
  return run(assetId, () => createMetric(assetId, input));
}
export async function updateMetricAction(assetId: number, metricId: number, patch: Record<string, unknown>) {
  return run(assetId, () => updateMetric(assetId, metricId, patch));
}
export async function deleteMetricAction(assetId: number, metricId: number, confirmName: string) {
  return run(assetId, () => deleteMetric(assetId, metricId, confirmName));
}
export async function addObservationAction(assetId: number, metricId: number, input: ObservationInput) {
  return run(assetId, () => addObservation(assetId, metricId, input));
}
export async function updateObservationAction(assetId: number, metricId: number, observationId: number, patch: Partial<ObservationInput>) {
  return run(assetId, () => updateObservation(assetId, metricId, observationId, patch));
}
export async function deleteObservationAction(assetId: number, metricId: number, observationId: number) {
  return run(assetId, () => deleteObservation(assetId, metricId, observationId));
}
export async function previewThresholdAction(assetId: number, metricId: number, input: ThresholdInput) {
  return run(assetId, () => previewThreshold(assetId, metricId, input), false);
}
export async function addThresholdAction(assetId: number, metricId: number, input: ThresholdInput) {
  return run(assetId, () => addThresholdVersion(assetId, metricId, input));
}
