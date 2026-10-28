/**
 * Asset custom metrics against the real database (and the running server for REST checks).
 * Creates TEST-LOCAL assets TLM-A / TLM-B and always removes them with their metrics.
 * Run: npm run check:asset-metrics [baseUrl]   (REST checks are skipped when the server is down)
 */
import "dotenv/config";
import { eq, inArray, like } from "drizzle-orm";
import { getDb, schema } from "../db";
import {
  MetricError,
  addObservation,
  addThresholdVersion,
  createMetric,
  deleteMetric,
  listObservations,
  metricSeries,
  metricsOverview,
  updateMetric,
  updateObservation,
} from "../server/services/asset-metrics";
import { changeAssetLifecycle } from "../server/services/asset-lifecycle";
import { loadPriceHistory } from "../server/services/prices";

const BASE = process.argv[2] ?? "http://localhost:3101";
const KEY = process.env.API_KEY ?? "";
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof MetricError ? `${e.status}:${e.code}` : `ERR:${(e as Error).message.slice(0, 80)}`;
  }
}

async function cleanup() {
  const db = getDb();
  const assets = await db.select({ id: schema.assets.id }).from(schema.assets).where(like(schema.assets.symbol, "TLM-%"));
  const ids = assets.map((a) => a.id);
  if (!ids.length) return 0;
  const defs = await db.select({ id: schema.assetMetricDefinitions.id }).from(schema.assetMetricDefinitions).where(inArray(schema.assetMetricDefinitions.assetId, ids));
  const d = defs.map((x) => x.id);
  if (d.length) {
    await db.delete(schema.assetMetricObservations).where(inArray(schema.assetMetricObservations.metricId, d));
    await db.delete(schema.assetMetricThresholdVersions).where(inArray(schema.assetMetricThresholdVersions.metricId, d));
    await db.delete(schema.assetMetricDefinitions).where(inArray(schema.assetMetricDefinitions.id, d));
  }
  await db.delete(schema.assetMetricEvents).where(inArray(schema.assetMetricEvents.assetId, ids));
  await db.delete(schema.assetLifecycleEvents).where(inArray(schema.assetLifecycleEvents.assetId, ids));
  await db.delete(schema.assets).where(inArray(schema.assets.id, ids));
  return ids.length;
}

async function main() {
  const db = getDb();
  await cleanup();
  const pricesBefore = JSON.stringify([...(await loadPriceHistory()).entries()]);
  try {
    const [A, B] = await db
      .insert(schema.assets)
      .values([
        { symbol: "TLM-A", name: "TEST-LOCAL metrics A (sample)", assetClass: "thai_stock" },
        { symbol: "TLM-B", name: "TEST-LOCAL metrics B (sample)", assetClass: "thai_stock" },
      ])
      .returning();

    // 1. Same name on two assets, isolated.
    const npl = await createMetric(A.id, { name: "NPL Ratio", unit: "%", frequency: "quarterly", decimals: 2 });
    const nplB = await createMetric(B.id, { name: "NPL Ratio", unit: "%", frequency: "quarterly" });
    check("same metric name on two assets", npl.assetId === A.id && nplB.assetId === B.id && npl.key === nplB.key);
    check("duplicate normalised key on one asset → 409", (await code(createMetric(A.id, { name: "npl ratio ", unit: "%" }))) === "409:DUPLICATE_METRIC");
    check("cross-asset read is refused (B's metric via A)", (await code(listObservations(A.id, nplB.id))) === "404:METRIC_NOT_FOUND");
    check("cross-asset write is refused", (await code(addObservation(A.id, nplB.id, { observedOn: "2025-03-31", value: 1 }))) === "404:METRIC_NOT_FOUND");

    // 2. Five metrics, multi-year observations (clearly sample data).
    const others = await Promise.all(
      [
        { name: "Coverage Ratio", unit: "%" },
        { name: "Net Profit", unit: "THB million" },
        { name: "CASA Ratio", unit: "%" },
        { name: "Branches", unit: "count", decimals: 0 },
      ].map((m) => createMetric(A.id, { ...m, frequency: "quarterly" })),
    );
    const quarters = ["2023-03-31", "2023-06-30", "2023-09-30", "2023-12-31", "2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30"];
    for (const [i, q] of quarters.entries()) {
      await addObservation(A.id, npl.id, { observedOn: q, value: (3.6 - i * 0.12).toFixed(2), source: "sample" });
      await addObservation(A.id, others[0].id, { observedOn: q, value: 150 + i * 4 });
      await addObservation(A.id, others[1].id, { observedOn: q, value: 9000 + i * 350 });
    }
    await addObservation(A.id, others[2].id, { observedOn: "2024-12-31", value: "71.5" });
    await addObservation(A.id, others[3].id, { observedOn: "2025-06-30", value: 1050 });
    await addObservation(B.id, nplB.id, { observedOn: "2025-06-30", value: 9.9 });
    const ov = await metricsOverview(A.id, { includeInactive: true });
    const n = ov.find((m) => m.id === npl.id)!;
    check("five metrics on one asset", ov.length === 5);
    check("latest summary = last observation", n.latest?.observedOn === "2025-06-30" && n.latest.valueText === "2.52" && n.observationCount === 10);
    check("B's history does not leak into A", !ov.some((m) => m.observations.some((o) => o.value === 9.9)));
    check("pp change for % metric", n.change.deltaLabel === "pp" && Math.abs(n.change.delta! + 0.12) < 1e-9);

    // 3. Duplicate date blocked; editing updates the same row.
    check("duplicate (metric, date) → 409 with existing id", (await code(addObservation(A.id, npl.id, { observedOn: "2025-06-30", value: 2 }))) === "409:DUPLICATE_OBSERVATION");
    const last = n.latest!;
    await updateObservation(A.id, npl.id, last.id, { value: "2.60" });
    const after = await listObservations(A.id, npl.id, { limit: 100 });
    check("edit updates the existing row", after.total === 10 && after.observations[0].id === last.id && after.observations[0].valueText === "2.60");
    check("invalid value rejected", (await code(addObservation(A.id, npl.id, { observedOn: "2025-09-30", value: "NaN" }))).startsWith("ERR") || (await code(addObservation(A.id, npl.id, { observedOn: "2025-09-30", value: "1e999" }))).startsWith("ERR"));

    // 4–6. Effective-dated thresholds.
    await addThresholdVersion(A.id, npl.id, { ruleType: "lower_is_better", effectiveFrom: "2024-01-01", greenBound: "2.5", yellowBound: "3.5", reason: "sample A" });
    await addThresholdVersion(A.id, npl.id, { ruleType: "lower_is_better", effectiveFrom: "2025-01-01", greenBound: "2.0", yellowBound: "3.0", reason: "sample B" });
    const thr = await metricsOverview(A.id);
    const h = thr.find((m) => m.id === npl.id)!;
    const st = (d: string) => h.observations.find((o) => o.observedOn === d)?.status;
    check("before any rule → NO_THRESHOLD", st("2023-12-31") === "NO_THRESHOLD");
    check("2024 observations use version A (3.12 → YELLOW, 2.76 → YELLOW)", st("2024-03-31") === "YELLOW" && st("2024-12-31") === "YELLOW");
    check("2025 observations use version B (2.64 → YELLOW under B)", st("2025-03-31") === "YELLOW");
    check("versions closed without overlap", h.thresholds.length === 2 && h.thresholds[0].effectiveTo === "2025-01-01" && h.thresholds[1].effectiveTo == null);
    check("backdated version refused", (await code(addThresholdVersion(A.id, npl.id, { ruleType: "lower_is_better", effectiveFrom: "2024-06-01", greenBound: 1, yellowBound: 2 }))) === "409:THRESHOLD_OVERLAP");
    check("rewriting a version already in effect refused", (await code(addThresholdVersion(A.id, npl.id, { ruleType: "lower_is_better", effectiveFrom: "2025-01-01", greenBound: 1, yellowBound: 2 }))) === "409:THRESHOLD_IN_EFFECT");
    // Concurrent: two new versions on the same future date → exactly one created, one refused/merged.
    const fut = "2099-01-01";
    const both = await Promise.all([
      code(addThresholdVersion(A.id, others[0].id, { ruleType: "higher_is_better", effectiveFrom: fut, yellowBound: 150, greenBound: 180 })),
      code(addThresholdVersion(A.id, others[0].id, { ruleType: "higher_is_better", effectiveFrom: fut, yellowBound: 140, greenBound: 170 })),
    ]);
    const cv = await db.select().from(schema.assetMetricThresholdVersions).where(eq(schema.assetMetricThresholdVersions.metricId, others[0].id));
    check("concurrent writes leave a single, non-overlapping version", cv.length === 1 && both.includes("OK"), both.join(" / "));

    // Series endpoints (service).
    const idx = await metricSeries(A.id, { metricIds: [npl.id, others[1].id], mode: "indexed" });
    check("indexed series starts at 100 for each metric", idx.series.every((s) => s.points[0] && Math.abs((s.points[0] as { value: number }).value - 100) < 1e-9));
    check("series of another asset's metric → 404", (await code(metricSeries(A.id, { metricIds: [nplB.id] }))) === "404:METRIC_NOT_FOUND");

    // Unit change needs confirmation; rename keeps id and history.
    check("unit change with data needs confirmation", (await code(updateMetric(A.id, npl.id, { unit: "bp" }))) === "409:UNIT_CHANGE_NEEDS_CONFIRMATION");
    const renamed = await updateMetric(A.id, npl.id, { name: "NPL ratio (gross)" });
    check("rename keeps id and key", renamed.id === npl.id && renamed.key === npl.key);

    // 11. Lifecycle: archive keeps history; permanent delete blocked by metrics.
    await updateMetric(A.id, others[3].id, { isActive: false });
    check("soft-archived metric keeps its observations", (await metricsOverview(A.id, { includeInactive: true })).find((m) => m.id === others[3].id)?.observationCount === 1);
    const hid = await changeAssetLifecycle({ assetId: A.id, action: "hide" });
    const arc = await changeAssetLifecycle({ assetId: A.id, action: "archive" });
    const del = await changeAssetLifecycle({ assetId: A.id, action: "delete", confirmSymbol: "TLM-A" });
    check("hide / archive asset keep metric history", hid.status === "HIDDEN" && arc.status === "ARCHIVED" && (await metricsOverview(A.id)).length === 4);
    check("asset delete blocked by custom metrics", del.status === "BLOCKED_HAS_DEPENDENCIES" && (del.dependencies as { customMetrics?: number }).customMetrics === 5);

    // Hard delete of a metric requires the exact name and leaves no orphans.
    check("metric hard delete needs exact name", (await code(deleteMetric(A.id, others[2].id, "casa"))) === "403:CONFIRMATION_REQUIRED");
    await deleteMetric(A.id, others[2].id, "CASA Ratio");
    const orphan = await db.select().from(schema.assetMetricObservations).where(eq(schema.assetMetricObservations.metricId, others[2].id));
    check("no orphan observations after metric delete", orphan.length === 0);
    const events = await db.select().from(schema.assetMetricEvents).where(eq(schema.assetMetricEvents.assetId, A.id));
    check("audit events recorded (create / update / close / delete)", ["create", "update", "close", "delete", "archive"].every((a) => events.some((e) => e.action === a)), `${events.length} events`);

    // 12. REST: auth, cross-asset, validation, stored text not executed.
    const up = await fetch(`${BASE}/login`).then((r) => r.ok).catch(() => false);
    if (!up) console.log("SKIP  REST checks — server not running at", BASE);
    else {
      const h = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
      const noAuth = await fetch(`${BASE}/api/v1/assets/${A.id}/metrics`);
      check("REST without key → 401", noAuth.status === 401);
      const list = await fetch(`${BASE}/api/v1/assets/${A.id}/metrics`, { headers: h });
      check("REST GET metrics", list.status === 200 && ((await list.json()) as unknown[]).length === 3);
      const cross = await fetch(`${BASE}/api/v1/assets/${A.id}/metrics/${nplB.id}/observations`, { method: "POST", headers: h, body: JSON.stringify({ observedOn: "2025-09-30", value: 1 }) });
      check("REST cross-asset write → 404", cross.status === 404);
      const dupR = await fetch(`${BASE}/api/v1/assets/${A.id}/metrics/${npl.id}/observations`, { method: "POST", headers: h, body: JSON.stringify({ observedOn: "2025-06-30", value: 1 }) });
      check("REST duplicate date → 409", dupR.status === 409);
      const bad = await fetch(`${BASE}/api/v1/assets/${A.id}/metrics/${npl.id}/thresholds`, { method: "POST", headers: h, body: JSON.stringify({ ruleType: "lower_is_better", effectiveFrom: "2099-06-01", greenBound: 5, yellowBound: 4 }) });
      check("REST invalid threshold → 400", bad.status === 400);
      const xss = await fetch(`${BASE}/api/v1/assets/${A.id}/metrics`, { method: "POST", headers: h, body: JSON.stringify({ name: "<img src=x onerror=alert(1)>", unit: "%" }) });
      const xj = (await xss.json()) as { name?: string };
      check("REST stores markup as plain text (rendered escaped by React)", xss.status === 201 && xj.name === "<img src=x onerror=alert(1)>");
      const big = await fetch(`${BASE}/api/v1/assets/${A.id}/metrics`, { method: "POST", headers: h, body: JSON.stringify({ name: "x".repeat(20_000), unit: "%" }) });
      check("REST oversized body refused", big.status === 400);
      const ser = await fetch(`${BASE}/api/v1/assets/${A.id}/metric-series?metricIds=${npl.id}&mode=change`, { headers: h });
      const sj = (await ser.json()) as { series: { points: { value: number | null }[] }[] };
      check("REST metric-series change mode", ser.status === 200 && sj.series[0].points[0].value === null);
    }

    // 15. Nothing else touched.
    check("price history unchanged", JSON.stringify([...(await loadPriceHistory()).entries()]) === pricesBefore);
  } finally {
    console.log(`cleaned up ${await cleanup()} test assets with their metrics`);
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => 0);
  process.exit(1);
});
