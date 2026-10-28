/**
 * MCP asset-metric tools end to end: the real MCP server (createMcpServer → SDK validation → safe() →
 * service → database) over an in-memory transport, plus the HTTP endpoint when the server is running.
 * Uses TEST-LOCAL assets TLM-MA / TLM-MB only and always removes them. Never touches real assets.
 * Run: npm run check:mcp-asset-metrics [baseUrl]
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { eq, inArray, like, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDb, schema } from "../db";
import { createMcpServer } from "../server/mcp";
import { ASSET_METRIC_TOOL_NAMES } from "../server/mcp-asset-metrics";

const BASE = process.argv[2] ?? "http://localhost:3101";
const KEY = process.env.API_KEY ?? "";
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

type Res = { ok: true; data: any } | { ok: false; code: string; text: string; detail?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
let client: Client;
async function call(name: string, args: Record<string, unknown>): Promise<Res> {
  const r = await client.callTool({ name, arguments: args });
  const c = r.content as { text: string }[];
  if (!r.isError) return { ok: true, data: JSON.parse(c[0].text) };
  const extra = c[1] ? (JSON.parse(c[1].text) as { code: string; detail?: unknown }) : null;
  return { ok: false, code: extra?.code ?? c[0].text.match(/\[([A-Z_]+)\]/)?.[1] ?? "SDK_VALIDATION", text: c[0].text, detail: extra?.detail };
}
const codeOf = (r: Res) => (r.ok ? "OK" : r.code);

async function cleanup() {
  const db = getDb();
  const assets = await db.select({ id: schema.assets.id }).from(schema.assets).where(like(schema.assets.symbol, "TLM-M%"));
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

/** Fingerprint of data the metric tools must never change (spec test 15). */
async function untouched() {
  const db = getDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h = async (table: any) =>
    createHash("sha256").update(JSON.stringify(await db.select().from(table).orderBy(sql`1`))).digest("hex");
  return {
    prices: await h(schema.prices),
    transactions: await h(schema.transactions),
    valuations: await h(schema.valuations),
    financialStatements: await h(schema.financialStatements),
    dividendEvents: await h(schema.dividendEvents),
    otherAssets: createHash("sha256")
      .update(JSON.stringify(await db.select().from(schema.assets).where(sql`${schema.assets.symbol} not like 'TLM-M%'`).orderBy(schema.assets.id)))
      .digest("hex"),
  };
}

async function main() {
  const db = getDb();
  await cleanup();
  const before = await untouched();
  const server = createMcpServer();
  client = new Client({ name: "check", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const [A, B] = await db
      .insert(schema.assets)
      .values([
        { symbol: "TLM-MA", name: "TEST-LOCAL MCP metrics A (sample)", assetClass: "thai_stock" },
        { symbol: "TLM-MB", name: "TEST-LOCAL MCP metrics B (sample)", assetClass: "thai_stock" },
      ])
      .returning();

    // Resolution: unknown symbol is refused and never auto-created.
    const nope = await call("create_asset_metric", { symbol: "TLM-MNOPE", name: "x", unit: "%" });
    const created = await db.select().from(schema.assets).where(eq(schema.assets.symbol, "TLM-MNOPE"));
    check("unknown symbol → ASSET_NOT_FOUND, no asset created", codeOf(nope) === "ASSET_NOT_FOUND" && created.length === 0);

    // 1/3. Create via symbol (case-insensitive); duplicate normalised name refused.
    const c1 = await call("create_asset_metric", { symbol: "tlm-ma", name: "NPL Ratio", unit: "%", frequency: "quarterly", decimals: 2 });
    const npl = c1.ok ? c1.data.metric : null;
    check("create via symbol (case-insensitive)", !!npl && npl.assetId === A.id && c1.ok && c1.data.symbol === "TLM-MA");
    const nb = await call("create_asset_metric", { symbol: "TLM-MB", name: "NPL Ratio", unit: "%" });
    const nplB = nb.ok ? nb.data.metric : null;
    const dup = await call("create_asset_metric", { symbol: "TLM-MA", name: " npl  ratio", unit: "%" });
    const defsA = await db.select().from(schema.assetMetricDefinitions).where(eq(schema.assetMetricDefinitions.assetId, A.id));
    check("3. duplicate normalised name → DUPLICATE_METRIC, nothing created", codeOf(dup) === "DUPLICATE_METRIC" && defsA.length === 1, dup.ok ? "" : dup.text.slice(0, 90));

    // 4. Observation keeps date, decimal value, source, publishedOn; provenance mcp.
    const o1 = await call("record_metric_observation", { symbol: "TLM-MA", metricId: npl.id, observedOn: "2024-03-31", value: "3.1", source: "Sample report Q1", publishedOn: "2024-05-15" });
    const row = o1.ok ? o1.data.observation : null;
    check("4. observation stored as given with sourceKind mcp", !!row && row.observedOn === "2024-03-31" && Number(row.value) === 3.1 && row.source === "Sample report Q1" && row.publishedOn === "2024-05-15" && row.sourceKind === "mcp");

    // 5. Duplicate date is refused (no silent upsert) with the existing id.
    const d5 = await call("record_metric_observation", { symbol: "TLM-MA", metricId: npl.id, observedOn: "2024-03-31", value: "9" });
    const still = await db.select().from(schema.assetMetricObservations).where(eq(schema.assetMetricObservations.metricId, npl.id));
    check("5. duplicate date → DUPLICATE_OBSERVATION with existing id, value unchanged", codeOf(d5) === "DUPLICATE_OBSERVATION" && !d5.ok && d5.detail?.observationId === row.id && still.length === 1 && Number(still[0].value) === 3.1);

    // 6. Zero and negative values are real values.
    await call("record_metric_observation", { symbol: "TLM-MA", metricId: npl.id, observedOn: "2024-06-30", value: 0 });
    const neg = await call("record_metric_observation", { symbol: "TLM-MA", metricId: npl.id, observedOn: "2024-09-30", value: "-0.25" });
    const h6 = await call("get_metric_history", { symbol: "TLM-MA", metricId: npl.id });
    const vals = h6.ok ? (h6.data.observations as { observedOn: string; value: number; status: string }[]) : [];
    check("6. zero / negative preserved (not empty)", vals.some((o) => o.observedOn === "2024-06-30" && o.value === 0) && vals.some((o) => o.value === -0.25) && vals.every((o) => o.status !== "NO_DATA"));

    // 7. Update edits the same row; delete needs confirmDelete true.
    const u7 = await call("update_metric_observation", { symbol: "TLM-MA", metricId: npl.id, observationId: row.id, value: "3.2" });
    check("7a. update edits the original record", u7.ok && u7.data.observation.id === row.id && Number(u7.data.observation.value) === 3.2 && u7.data.observation.source === "Sample report Q1");
    const negId = neg.ok ? neg.data.observation.id : -1;
    const noConfirm = await call("delete_metric_observation", { symbol: "TLM-MA", metricId: npl.id, observationId: negId });
    const falseConfirm = await call("delete_metric_observation", { symbol: "TLM-MA", metricId: npl.id, observationId: negId, confirmDelete: false });
    const stillNeg = await db.select().from(schema.assetMetricObservations).where(eq(schema.assetMetricObservations.id, negId));
    check("7b. delete without confirmDelete true is refused", !noConfirm.ok && !falseConfirm.ok && stillNeg.length === 1);
    const del7 = await call("delete_metric_observation", { symbol: "TLM-MA", metricId: npl.id, observationId: negId, confirmDelete: true });
    check("7c. delete with confirmDelete true", del7.ok && (await db.select().from(schema.assetMetricObservations).where(eq(schema.assetMetricObservations.id, negId))).length === 0);

    // 8. Ownership: wrong asset / metric / observation combinations denied.
    const bObs = await call("record_metric_observation", { symbol: "TLM-MB", metricId: nplB.id, observedOn: "2024-03-31", value: 9.9 });
    const bObsId = bObs.ok ? bObs.data.observation.id : -1;
    const x1 = await call("record_metric_observation", { symbol: "TLM-MA", metricId: nplB.id, observedOn: "2024-12-31", value: 1 });
    const x2 = await call("get_metric_history", { symbol: "TLM-MA", metricId: nplB.id });
    const x3 = await call("update_metric_observation", { symbol: "TLM-MA", metricId: npl.id, observationId: bObsId, value: 1 });
    const x4 = await call("delete_metric_observation", { symbol: "TLM-MA", metricId: npl.id, observationId: bObsId, confirmDelete: true });
    const x5 = await call("get_metric_series", { symbol: "TLM-MA", metricIds: [nplB.id] });
    const x6 = await call("delete_asset_metric", { symbol: "TLM-MA", metricId: nplB.id, confirmName: "NPL Ratio" });
    check(
      "8. cross-asset metric / observation denied",
      [x1, x2, x5, x6].every((r) => codeOf(r) === "METRIC_NOT_FOUND") && [x3, x4].every((r) => codeOf(r) === "OBSERVATION_NOT_FOUND"),
      [x1, x2, x3, x4, x5, x6].map(codeOf).join(","),
    );
    const bAfter = await db.select().from(schema.assetMetricObservations).where(eq(schema.assetMetricObservations.id, bObsId));
    check("8b. B's observation untouched", bAfter.length === 1 && Number(bAfter[0].value) === 9.9);

    // 2. List: own asset only, summaries without observation arrays by default.
    const l2 = await call("list_asset_metrics", { symbol: "TLM-MA" });
    const ms = l2.ok ? (l2.data.metrics as { id: number; observations: unknown[]; observationCount: number }[]) : [];
    check("2. list returns this asset only, no observation arrays by default", ms.length === 1 && ms[0].id === npl.id && ms[0].observations.length === 0 && ms[0].observationCount === 2);
    const l2b = await call("list_asset_metrics", { symbol: "TLM-MA", withObservations: true });
    check("2b. withObservations true includes them", l2b.ok && l2b.data.metrics[0].observations.length === 2);

    // 9. Unit change needs confirmation; values not converted.
    const u9 = await call("update_asset_metric", { symbol: "TLM-MA", metricId: npl.id, unit: "bp" });
    const u9b = await call("update_asset_metric", { symbol: "TLM-MA", metricId: npl.id, unit: "bp", confirmUnitChange: true });
    const vals9 = (await db.select().from(schema.assetMetricObservations).where(eq(schema.assetMetricObservations.metricId, npl.id))).map((o) => Number(o.value)).sort();
    check("9. unit change needs confirmUnitChange; values kept as-is", codeOf(u9) === "UNIT_CHANGE_NEEDS_CONFIRMATION" && u9b.ok && u9b.data.metric.unit === "bp" && JSON.stringify(vals9) === JSON.stringify([0, 3.2]));
    await call("update_asset_metric", { symbol: "TLM-MA", metricId: npl.id, unit: "%", confirmUnitChange: true });
    const partial = await call("update_asset_metric", { symbol: "TLM-MA", metricId: npl.id, description: "sample" });
    check("partial update keeps frequency / decimals", partial.ok && partial.data.metric.frequency === "quarterly" && partial.data.metric.decimals === 2);

    // 11. Preview writes nothing; invalid / overlapping versions fail.
    const evBefore = (await db.select().from(schema.assetMetricEvents).where(eq(schema.assetMetricEvents.assetId, A.id))).length;
    const pv = await call("preview_metric_threshold", { symbol: "TLM-MA", metricId: npl.id, ruleType: "lower_is_better", effectiveFrom: "2024-01-01", greenBound: "2.5", yellowBound: "3.5" });
    const thrAfterPreview = await db.select().from(schema.assetMetricThresholdVersions).where(eq(schema.assetMetricThresholdVersions.metricId, npl.id));
    const evAfter = (await db.select().from(schema.assetMetricEvents).where(eq(schema.assetMetricEvents.assetId, A.id))).length;
    check("11a. preview classifies and writes nothing", pv.ok && pv.data.saved === false && pv.data.affected === 2 && thrAfterPreview.length === 0 && evAfter === evBefore);
    const bad = await call("set_metric_threshold", { symbol: "TLM-MA", metricId: npl.id, ruleType: "lower_is_better", effectiveFrom: "2024-01-01", greenBound: 5, yellowBound: 4 });
    const badRange = await call("set_metric_threshold", { symbol: "TLM-MA", metricId: npl.id, ruleType: "target_range", effectiveFrom: "2024-01-01", greenMin: 1 });
    check("11b. invalid rule → VALIDATION_ERROR", codeOf(bad) === "VALIDATION_ERROR" && codeOf(badRange) === "VALIDATION_ERROR", `${codeOf(bad)} ${codeOf(badRange)}`);
    const t1 = await call("set_metric_threshold", { symbol: "TLM-MA", metricId: npl.id, ruleType: "lower_is_better", effectiveFrom: "2024-01-01", greenBound: "2.5", yellowBound: "3.5", reason: "sample user rule" });
    const t2 = await call("set_metric_threshold", { symbol: "TLM-MA", metricId: npl.id, ruleType: "lower_is_better", effectiveFrom: "2024-07-01", greenBound: "3.6", yellowBound: "4.0", reason: "sample user rule 2" });
    const back = await call("set_metric_threshold", { symbol: "TLM-MA", metricId: npl.id, ruleType: "lower_is_better", effectiveFrom: "2024-03-01", greenBound: 1, yellowBound: 2 });
    const same = await call("set_metric_threshold", { symbol: "TLM-MA", metricId: npl.id, ruleType: "lower_is_better", effectiveFrom: "2024-07-01", greenBound: 1, yellowBound: 2 });
    check("11c. backdated → THRESHOLD_OVERLAP, in-effect rewrite → THRESHOLD_IN_EFFECT", t1.ok && t2.ok && codeOf(back) === "THRESHOLD_OVERLAP" && codeOf(same) === "THRESHOLD_IN_EFFECT");
    const lt = await call("list_metric_thresholds", { symbol: "TLM-MA", metricId: npl.id });
    check("11d. versions closed without overlap", lt.ok && lt.data.versions.length === 2 && lt.data.versions[0].effectiveTo === "2024-07-01" && lt.data.versions[1].effectiveTo === null);

    // 10/12. Boundaries on stored data and statuses under the version in force on each date.
    for (const [d, v] of [["2024-12-31", "3.6"], ["2025-03-31", "4.0"], ["2025-06-30", "4.0001"]] as const) await call("record_metric_observation", { symbol: "TLM-MA", metricId: npl.id, observedOn: d, value: v });
    const h12 = await call("get_metric_history", { symbol: "TLM-MA", metricId: npl.id });
    const st = (d: string) => (h12.ok ? (h12.data.observations as { observedOn: string; status: string; versionId: number | null }[]).find((o) => o.observedOn === d) : undefined);
    check("12. 2024-03-31 (3.2) under v1 → YELLOW; 2024-06-30 (0) → GREEN", st("2024-03-31")?.status === "YELLOW" && st("2024-06-30")?.status === "GREEN" && st("2024-03-31")?.versionId === (t1.ok ? t1.data.version.id : -1));
    check("10. v2 equality: 3.6 GREEN, 4.0 YELLOW, 4.0001 RED", st("2024-12-31")?.status === "GREEN" && st("2025-03-31")?.status === "YELLOW" && st("2025-06-30")?.status === "RED");

    // 13/14. Series: indexed with base ≤ 0 unavailable; change keeps null + reason.
    const idx = await call("get_metric_series", { symbol: "TLM-MA", metricIds: [npl.id], from: "2024-06-30", mode: "indexed" });
    check("13. indexed with zero base → unavailable, no points", idx.ok && !!idx.data.series[0].unavailable && idx.data.series[0].points.length === 0);
    const chg = await call("get_metric_series", { symbol: "TLM-MA", metricIds: [npl.id], mode: "change" });
    const cp = chg.ok ? (chg.data.series[0].points as { date: string; value: number | null; reason: string | null }[]) : [];
    const afterZero = cp.find((p) => p.date === "2024-12-31");
    check("14. change after a zero value → null with reason, no interpolation", afterZero?.value === null && !!afterZero?.reason && cp.length === 5);
    const act = await call("get_metric_series", { symbol: "TLM-MA", mode: "actual", from: "2024-06-01", to: "2024-12-31" });
    check("series window filter (inclusive)", act.ok && act.data.series[0].points.length === 2);

    // 17. Pagination and filters; reversed range visible failure.
    const p1 = await call("get_metric_history", { symbol: "TLM-MA", metricId: npl.id, limit: 2, offset: 1 });
    const f1 = await call("get_metric_history", { symbol: "TLM-MA", metricId: npl.id, from: "2024-06-30", to: "2024-12-31" });
    const rev = await call("get_metric_history", { symbol: "TLM-MA", metricId: npl.id, from: "2025-01-01", to: "2024-01-01" });
    check(
      "17. pagination / date filter / reversed range",
      p1.ok && p1.data.total === 5 && p1.data.observations.length === 2 && p1.data.observations[0].observedOn === "2025-03-31" && f1.ok && f1.data.total === 2 && codeOf(rev) === "VALIDATION_ERROR",
    );

    // 18. Archive / restore keep history; permanent delete needs exact name.
    await call("update_asset_metric", { symbol: "TLM-MA", metricId: npl.id, isActive: false });
    const hidden = await call("list_asset_metrics", { symbol: "TLM-MA" });
    const incl = await call("list_asset_metrics", { symbol: "TLM-MA", includeInactive: true });
    await call("update_asset_metric", { symbol: "TLM-MA", metricId: npl.id, isActive: true });
    const restored = await call("list_asset_metrics", { symbol: "TLM-MA" });
    check(
      "18a. archive hides, restore returns with observations and thresholds intact",
      hidden.ok && hidden.data.metrics.length === 0 && incl.ok && incl.data.metrics[0].observationCount === 5 && restored.ok && restored.data.metrics[0].observationCount === 5 && restored.data.metrics[0].thresholds.length === 2,
    );
    const wrongName = await call("delete_asset_metric", { symbol: "TLM-MB", metricId: nplB.id, confirmName: "npl ratio" });
    const delB = await call("delete_asset_metric", { symbol: "TLM-MB", metricId: nplB.id, confirmName: "NPL Ratio" });
    const orphan = await db.select().from(schema.assetMetricObservations).where(eq(schema.assetMetricObservations.metricId, nplB.id));
    check("18b. delete needs exact confirmName; no orphans", codeOf(wrongName) === "CONFIRMATION_REQUIRED" && delB.ok && delB.data.deleted === true && orphan.length === 0);

    // Provenance: every audit event written through MCP is source mcp.
    const ev = await db.select().from(schema.assetMetricEvents).where(inArray(schema.assetMetricEvents.assetId, [A.id, B.id]));
    check("audit events carry source mcp", ev.length > 10 && ev.every((e) => e.source === "mcp"), `${ev.length} events`);

    // 16. HTTP endpoint: unauthorized rejected; authorized tools/list exposes the new tools.
    const up = await fetch(`${BASE}/login`).then((r) => r.ok).catch(() => false);
    if (!up) console.log("SKIP  HTTP checks — server not running at", BASE);
    else {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      const noAuth = await fetch(`${BASE}/api/mcp`, { method: "POST", headers, body });
      const badKey = await fetch(`${BASE}/api/mcp?key=wrong`, { method: "POST", headers, body });
      check("16a. /api/mcp without / with wrong key → 401", noAuth.status === 401 && badKey.status === 401);
      if (!KEY) console.log("SKIP  authorized tools/list — API_KEY not set");
      else {
        const ok = await fetch(`${BASE}/api/mcp`, { method: "POST", headers: { ...headers, authorization: `Bearer ${KEY}` }, body });
        const text = await ok.text();
        check("16b. authorized tools/list includes the 12 metric tools", ok.status === 200 && ASSET_METRIC_TOOL_NAMES.every((n) => text.includes(`"${n}"`)));
      }
    }

    // 15. Nothing outside asset metrics changed.
    const after = await untouched();
    for (const k of Object.keys(before) as (keyof typeof before)[]) check(`15. ${k} unchanged`, before[k] === after[k]);
  } finally {
    await client.close().catch(() => undefined);
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
