/**
 * Asset custom metrics: the single business-logic entry point for UI, REST (and later MCP).
 * Every read and write is scoped by asset id; client-supplied ids, statuses or timestamps are
 * never trusted. Writes run in a transaction with an audit event. Nothing here touches prices,
 * transactions, valuations or any portfolio calculation.
 */
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  metricDefinitionInput,
  metricDefinitionPatch,
  metricKey,
  observationInput,
  observationPatch,
  observationQuery,
  thresholdInput,
  type MetricDefinitionInput,
  type ObservationInput,
  type ThresholdInput,
} from "@/lib/asset-metrics/schemas";
import { evaluateThreshold, freshness, ruleForDate, statusOn, type MetricStatus, type ThresholdVersion } from "@/lib/asset-metrics/thresholds";
import { indexSeries, inWindow, latestChange, pctChangeSeries } from "@/lib/asset-metrics/series";
import { today } from "@/lib/validation";

export class MetricError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    public code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Def = typeof schema.assetMetricDefinitions.$inferSelect;
type ObsRow = typeof schema.assetMetricObservations.$inferSelect;
type ThrRow = typeof schema.assetMetricThresholdVersions.$inferSelect;
const D = schema.assetMetricDefinitions;
const O = schema.assetMetricObservations;
const T = schema.assetMetricThresholdVersions;

const isUnique = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
};

async function audit(db: Db | Tx, assetId: number, objectType: string, objectId: number, action: string, before: unknown, after: unknown, source = "web") {
  await db.insert(schema.assetMetricEvents).values({ assetId, objectType, objectId, action, before: before ?? null, after: after ?? null, source });
}

async function requireAsset(db: Db | Tx, assetId: number) {
  if (!Number.isInteger(assetId) || assetId <= 0) throw new MetricError(404, "ASSET_NOT_FOUND", "ไม่พบสินทรัพย์");
  const [a] = await db.select({ id: schema.assets.id, symbol: schema.assets.symbol }).from(schema.assets).where(eq(schema.assets.id, assetId));
  if (!a) throw new MetricError(404, "ASSET_NOT_FOUND", "ไม่พบสินทรัพย์");
  return a;
}

/** The metric only when it belongs to this asset (prevents cross-asset access). */
async function requireMetric(db: Db | Tx, assetId: number, metricId: number, lock = false): Promise<Def> {
  if (!Number.isInteger(metricId) || metricId <= 0) throw new MetricError(404, "METRIC_NOT_FOUND", "ไม่พบตัวชี้วัดของสินทรัพย์นี้");
  const q = db.select().from(D).where(and(eq(D.id, metricId), eq(D.assetId, assetId)));
  const [m] = lock ? await q.for("update") : await q;
  if (!m) throw new MetricError(404, "METRIC_NOT_FOUND", "ไม่พบตัวชี้วัดของสินทรัพย์นี้");
  return m;
}

async function requireObservation(db: Db | Tx, metricId: number, observationId: number): Promise<ObsRow> {
  const [o] = await db.select().from(O).where(and(eq(O.id, observationId), eq(O.metricId, metricId)));
  if (!o) throw new MetricError(404, "OBSERVATION_NOT_FOUND", "ไม่พบค่าที่บันทึกของตัวชี้วัดนี้");
  return o;
}

const toVersion = (t: ThrRow): ThresholdVersion & ThrRow => ({ ...t, effectiveTo: t.effectiveTo ?? null });
const obsOut = (o: ObsRow, versions: ThresholdVersion[]) => ({
  id: o.id,
  observedOn: o.observedOn,
  value: Number(o.value),
  valueText: o.value,
  source: o.source,
  note: o.note,
  publishedOn: o.publishedOn,
  sourceKind: o.sourceKind,
  recordedAt: o.recordedAt,
  updatedAt: o.updatedAt,
  ...statusOn(versions, o.observedOn, o.value),
});
export type ObservationOut = ReturnType<typeof obsOut>;

// ------------------------------------------------------------------ definitions

export async function createMetric(assetId: number, input: MetricDefinitionInput, source = "web") {
  const x = metricDefinitionInput.parse(input);
  const key = metricKey(x.name);
  if (!key) throw new MetricError(400, "INVALID_NAME", "ชื่อตัวชี้วัดต้องมีตัวอักษรหรือตัวเลข");
  return getDb().transaction(async (tx) => {
    await requireAsset(tx, assetId);
    const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${D.displayOrder}), -1)::int + 1` }).from(D).where(eq(D.assetId, assetId));
    try {
      const [row] = await tx.insert(D).values({ ...x, key, assetId, displayOrder: n }).returning();
      await audit(tx, assetId, "metric", row.id, "create", null, row, source);
      return row;
    } catch (e) {
      if (isUnique(e)) throw new MetricError(409, "DUPLICATE_METRIC", `สินทรัพย์นี้มีตัวชี้วัดชื่อ "${x.name}" (หรือชื่อที่ตรงกันหลังปรับรูปแบบ) อยู่แล้ว`);
      throw e;
    }
  });
}

export async function updateMetric(assetId: number, metricId: number, patch: unknown, source = "web") {
  const x = metricDefinitionPatch.parse(patch);
  return getDb().transaction(async (tx) => {
    const m = await requireMetric(tx, assetId, metricId, true);
    if (x.unit != null && x.unit.trim() !== m.unit) {
      const [{ c }] = await tx.select({ c: sql<number>`count(*)::int` }).from(O).where(eq(O.metricId, m.id));
      if (c > 0 && !x.confirmUnitChange)
        throw new MetricError(409, "UNIT_CHANGE_NEEDS_CONFIRMATION", `มีค่าที่บันทึกไว้ ${c} รายการในหน่วย "${m.unit}" — เปลี่ยนหน่วยจะไม่แปลงค่าเดิม ยืนยัน (confirmUnitChange) ถ้าต้องการเปลี่ยนจริง`, { observations: c });
    }
    const { confirmUnitChange: _c, ...rest } = x;
    const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    if (!Object.keys(set).length) return m;
    // The key is immutable: renaming never detaches history.
    const [row] = await tx.update(D).set({ ...set, updatedAt: new Date() }).where(eq(D.id, m.id)).returning();
    await audit(tx, assetId, "metric", m.id, x.isActive === false ? "archive" : x.isActive === true && !m.isActive ? "restore" : "update", m, row, source);
    return row;
  });
}

/** Hard delete (metric, its observations and thresholds) — only with the exact metric name typed. */
export async function deleteMetric(assetId: number, metricId: number, confirmName: string, source = "web") {
  return getDb().transaction(async (tx) => {
    const m = await requireMetric(tx, assetId, metricId, true);
    if ((confirmName ?? "").trim() !== m.name) throw new MetricError(403, "CONFIRMATION_REQUIRED", `พิมพ์ชื่อตัวชี้วัด "${m.name}" ให้ตรงเพื่อยืนยันการลบถาวร`);
    const [{ obs }] = await tx.select({ obs: sql<number>`count(*)::int` }).from(O).where(eq(O.metricId, m.id));
    const [{ thr }] = await tx.select({ thr: sql<number>`count(*)::int` }).from(T).where(eq(T.metricId, m.id));
    await tx.delete(O).where(eq(O.metricId, m.id));
    await tx.delete(T).where(eq(T.metricId, m.id));
    await tx.delete(D).where(eq(D.id, m.id));
    await audit(tx, assetId, "metric", m.id, "delete", { ...m, observations: obs, thresholds: thr }, null, source);
    return { deleted: true, observations: obs, thresholds: thr };
  });
}

// ------------------------------------------------------------------ observations

export async function addObservation(assetId: number, metricId: number, input: ObservationInput, source = "web") {
  const x = observationInput.parse(input);
  return getDb().transaction(async (tx) => {
    const m = await requireMetric(tx, assetId, metricId);
    const [dup] = await tx.select({ id: O.id, value: O.value }).from(O).where(and(eq(O.metricId, m.id), eq(O.observedOn, x.observedOn)));
    if (dup) throw new MetricError(409, "DUPLICATE_OBSERVATION", `มีค่าของวันที่ ${x.observedOn} อยู่แล้ว (${dup.value}) — แก้ค่าเดิมแทนการเพิ่มซ้ำ`, { observationId: dup.id, value: dup.value });
    try {
      const [row] = await tx
        .insert(O)
        .values({ metricId: m.id, observedOn: x.observedOn, value: x.value, source: x.source ?? m.sourceDefault, note: x.note, publishedOn: x.publishedOn, sourceKind: source === "web" ? "manual" : source })
        .returning();
      await audit(tx, assetId, "observation", row.id, "create", null, row, source);
      return row;
    } catch (e) {
      if (isUnique(e)) throw new MetricError(409, "DUPLICATE_OBSERVATION", `มีค่าของวันที่ ${x.observedOn} อยู่แล้ว — แก้ค่าเดิมแทน`);
      throw e;
    }
  });
}

export async function updateObservation(assetId: number, metricId: number, observationId: number, patch: unknown, source = "web") {
  const x = observationPatch.parse(patch);
  return getDb().transaction(async (tx) => {
    const m = await requireMetric(tx, assetId, metricId);
    const o = await requireObservation(tx, m.id, observationId);
    const set = Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined));
    if (!Object.keys(set).length) return o;
    try {
      const [row] = await tx.update(O).set({ ...set, updatedAt: new Date() }).where(eq(O.id, o.id)).returning();
      await audit(tx, assetId, "observation", o.id, "update", o, row, source);
      return row;
    } catch (e) {
      if (isUnique(e)) throw new MetricError(409, "DUPLICATE_OBSERVATION", `มีค่าของวันที่ ${x.observedOn} อยู่แล้ว`);
      throw e;
    }
  });
}

export async function deleteObservation(assetId: number, metricId: number, observationId: number, source = "web") {
  return getDb().transaction(async (tx) => {
    const m = await requireMetric(tx, assetId, metricId);
    const o = await requireObservation(tx, m.id, observationId);
    await tx.delete(O).where(eq(O.id, o.id));
    await audit(tx, assetId, "observation", o.id, "delete", o, null, source);
    return { deleted: true, id: o.id };
  });
}

export async function listObservations(assetId: number, metricId: number, query: unknown = {}) {
  const q = observationQuery.parse(query);
  const db = getDb();
  await requireAsset(db, assetId);
  const m = await requireMetric(db, assetId, metricId);
  const versions = (await db.select().from(T).where(eq(T.metricId, m.id)).orderBy(asc(T.effectiveFrom))).map(toVersion);
  const where = and(eq(O.metricId, m.id), q.from ? gte(O.observedOn, q.from) : undefined, q.to ? lte(O.observedOn, q.to) : undefined);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(O).where(where).orderBy(desc(O.observedOn)).limit(q.limit).offset(q.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(O).where(where),
  ]);
  return { metric: { id: m.id, name: m.name, unit: m.unit }, total, limit: q.limit, offset: q.offset, observations: rows.map((o) => obsOut(o, versions)) };
}

// ------------------------------------------------------------------ thresholds

export async function listThresholds(assetId: number, metricId: number) {
  const db = getDb();
  const m = await requireMetric(db, assetId, metricId);
  return (await db.select().from(T).where(eq(T.metricId, m.id)).orderBy(asc(T.effectiveFrom))).map(toVersion);
}

/**
 * Effect of a proposed version on observations dated on/after its start (nothing is written).
 * Earlier observations keep the rule that was in effect on their own date.
 */
export async function previewThreshold(assetId: number, metricId: number, input: ThresholdInput) {
  const x = thresholdInput.parse(input);
  const db = getDb();
  const m = await requireMetric(db, assetId, metricId);
  const versions = (await db.select().from(T).where(eq(T.metricId, m.id)).orderBy(asc(T.effectiveFrom))).map(toVersion);
  const obs = await db.select().from(O).where(and(eq(O.metricId, m.id), gte(O.observedOn, x.effectiveFrom))).orderBy(asc(O.observedOn));
  const rows = obs.map((o) => {
    const before = statusOn(versions, o.observedOn, o.value).status;
    const after = evaluateThreshold(o.value, x).status;
    return { observedOn: o.observedOn, value: Number(o.value), before, after };
  });
  return { effectiveFrom: x.effectiveFrom, affected: rows.length, changed: rows.filter((r) => r.before !== r.after).length, rows };
}

/**
 * Add an effective-dated version. The metric row is locked so concurrent writes serialise.
 * - start after the latest version → the open latest version is closed on that date;
 * - same start as the latest version → replaced, only while that start is still in the future;
 * - earlier start → refused (would rewrite statuses already shown for past observations).
 */
export async function addThresholdVersion(assetId: number, metricId: number, input: ThresholdInput, source = "web") {
  const x = thresholdInput.parse(input);
  const now = today();
  return getDb().transaction(async (tx) => {
    const m = await requireMetric(tx, assetId, metricId, true);
    const versions = await tx.select().from(T).where(eq(T.metricId, m.id)).orderBy(desc(T.effectiveFrom));
    const latest = versions[0];
    const bounds = { ruleType: x.ruleType, greenBound: x.greenBound, yellowBound: x.yellowBound, greenMin: x.greenMin, greenMax: x.greenMax, yellowMin: x.yellowMin, yellowMax: x.yellowMax, reason: x.reason, source: x.source };
    if (latest && x.effectiveFrom < latest.effectiveFrom)
      throw new MetricError(409, "THRESHOLD_OVERLAP", `มีเกณฑ์ที่เริ่ม ${latest.effectiveFrom} อยู่แล้ว — เกณฑ์ใหม่ต้องเริ่มหลังวันนั้น (ไม่ย้อนแก้สถานะในอดีต)`, { latestEffectiveFrom: latest.effectiveFrom });
    if (latest && x.effectiveFrom === latest.effectiveFrom) {
      if (latest.effectiveFrom <= now)
        throw new MetricError(409, "THRESHOLD_IN_EFFECT", `เกณฑ์ที่เริ่ม ${latest.effectiveFrom} มีผลแล้ว — ตั้งเกณฑ์ใหม่ด้วยวันเริ่มที่ใหม่กว่า แทนการแก้ย้อนหลัง`);
      const [row] = await tx.update(T).set({ ...bounds, updatedAt: new Date() }).where(eq(T.id, latest.id)).returning();
      await audit(tx, assetId, "threshold", row.id, "update", latest, row, source);
      return row;
    }
    if (latest && (latest.effectiveTo == null || latest.effectiveTo > x.effectiveFrom)) {
      const [closed] = await tx.update(T).set({ effectiveTo: x.effectiveFrom, updatedAt: new Date() }).where(eq(T.id, latest.id)).returning();
      await audit(tx, assetId, "threshold", latest.id, "close", latest, closed, source);
    }
    try {
      const [row] = await tx.insert(T).values({ metricId: m.id, effectiveFrom: x.effectiveFrom, effectiveTo: null, ...bounds }).returning();
      await audit(tx, assetId, "threshold", row.id, "create", null, row, source);
      return row;
    } catch (e) {
      if (isUnique(e)) throw new MetricError(409, "THRESHOLD_OVERLAP", `มีเกณฑ์ที่เริ่ม ${x.effectiveFrom} อยู่แล้ว`);
      throw e;
    }
  });
}

// ------------------------------------------------------------------ overview for the asset page / GET metrics

const MAX_OBS_PER_ASSET = 5000;

export interface MetricOverview {
  id: number;
  key: string;
  name: string;
  unit: string;
  description: string | null;
  frequency: string;
  decimals: number;
  chartColor: string | null;
  sourceDefault: string | null;
  showInChart: boolean;
  isActive: boolean;
  displayOrder: number;
  latest: ObservationOut | null;
  change: ReturnType<typeof latestChange>;
  status: MetricStatus;
  statusExplanation: string;
  freshness: ReturnType<typeof freshness>;
  thresholds: (ThresholdVersion & ThrRow)[];
  currentThreshold: (ThresholdVersion & ThrRow) | null;
  observationCount: number;
  observations: ObservationOut[];
}

/** Definitions with observations (ascending, bounded), statuses under the version in effect on each date, and thresholds. */
export async function metricsOverview(assetId: number, opts: { includeInactive?: boolean; withObservations?: boolean } = {}): Promise<MetricOverview[]> {
  const db = getDb();
  await requireAsset(db, assetId);
  const defs = await db
    .select()
    .from(D)
    .where(and(eq(D.assetId, assetId), opts.includeInactive ? undefined : eq(D.isActive, true)))
    .orderBy(asc(D.displayOrder), asc(D.id));
  if (!defs.length) return [];
  const ids = defs.map((d) => d.id);
  const [obs, thr] = await Promise.all([
    db
      .select()
      .from(O)
      .where(sql`${O.metricId} in ${ids}`)
      .orderBy(desc(O.observedOn))
      .limit(MAX_OBS_PER_ASSET),
    db
      .select()
      .from(T)
      .where(sql`${T.metricId} in ${ids}`)
      .orderBy(asc(T.effectiveFrom)),
  ]);
  const now = today();
  return defs.map((d) => {
    const versions = thr.filter((t) => t.metricId === d.id).map(toVersion);
    const own = obs.filter((o) => o.metricId === d.id).sort((a, b) => a.observedOn.localeCompare(b.observedOn)).map((o) => obsOut(o, versions));
    const latest = own[own.length - 1] ?? null;
    const st = latest ? { status: latest.status, explanation: latest.explanation } : { status: "NO_DATA" as const, explanation: "ยังไม่มีค่าที่บันทึก" };
    return {
      id: d.id,
      key: d.key,
      name: d.name,
      unit: d.unit,
      description: d.description,
      frequency: d.frequency,
      decimals: d.decimals,
      chartColor: d.chartColor,
      sourceDefault: d.sourceDefault,
      showInChart: d.showInChart,
      isActive: d.isActive,
      displayOrder: d.displayOrder,
      latest,
      change: latestChange(own.map((o) => ({ date: o.observedOn, value: o.value })), d.unit),
      status: st.status,
      statusExplanation: st.explanation,
      freshness: freshness(d.frequency, latest?.observedOn ?? null, now),
      thresholds: versions,
      currentThreshold: ruleForDate(versions, now),
      observationCount: own.length,
      observations: opts.withObservations === false ? [] : own,
    };
  });
}

/** Chart-ready series for selected metrics of one asset, with the transformation documented per mode. */
export async function metricSeries(assetId: number, q: { metricIds?: number[]; from?: string | null; to?: string | null; mode?: "actual" | "indexed" | "change" }) {
  const all = await metricsOverview(assetId, { includeInactive: true });
  const pick = q.metricIds?.length ? all.filter((m) => q.metricIds!.includes(m.id)) : all.filter((m) => m.isActive);
  const unknown = (q.metricIds ?? []).filter((id) => !all.some((m) => m.id === id));
  if (unknown.length) throw new MetricError(404, "METRIC_NOT_FOUND", `ไม่พบตัวชี้วัด ${unknown.join(", ")} ของสินทรัพย์นี้`);
  const mode = q.mode ?? "actual";
  return {
    mode,
    from: q.from ?? null,
    to: q.to ?? null,
    definition:
      mode === "indexed"
        ? "index(t) = 100 × value(t) / value(first observation in window); unavailable when that base ≤ 0"
        : mode === "change"
          ? "100 × (value(t) − value(previous actual observation)) / |previous|; null when previous is 0, negative or the sign changes"
          : "raw observed values in the metric's unit; no interpolation or fill",
    series: pick.map((m) => {
      const pts = inWindow(m.observations.map((o) => ({ date: o.observedOn, value: o.value })), q.from ?? null, q.to ?? null);
      const statusBy = new Map(m.observations.map((o) => [o.observedOn, o.status]));
      if (mode === "indexed") {
        const r = indexSeries(pts);
        return { id: m.id, name: m.name, unit: m.unit, ...(r.ok ? { baseDate: r.baseDate, baseValue: r.baseValue, points: r.points.map((p) => ({ ...p, status: statusBy.get(p.date) })) } : { unavailable: r.reason, baseDate: r.baseDate, points: [] }) };
      }
      if (mode === "change") return { id: m.id, name: m.name, unit: m.unit, points: pctChangeSeries(pts).map((p) => ({ ...p, status: statusBy.get(p.date) })) };
      return { id: m.id, name: m.name, unit: m.unit, points: pts.map((p) => ({ ...p, status: statusBy.get(p.date) })) };
    }),
  };
}

/** Number of metric definitions per asset (lifecycle delete guard). */
export async function metricDefinitionCount(db: Db | Tx, assetId: number) {
  const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(D).where(eq(D.assetId, assetId));
  return c;
}
