/**
 * MCP tools for asset custom metrics (user-defined per-asset measures such as an NPL ratio).
 * Thin adapters: the asset is resolved from `symbol` (never auto-created) and every call goes to
 * the existing service in services/asset-metrics.ts with source "mcp" — business rules, ownership
 * checks, transactions and audit live there. Not to be confused with get_performance_metrics.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as metricService from "./services/asset-metrics";
import { MetricError } from "./services/asset-metrics";
import { getAssetBySymbol } from "./services/assets";
import { metricDefinitionInput, metricDefinitionPatch, observationInput, observationPatch, thresholdInput } from "@/lib/asset-metrics/schemas";

const SOURCE = "mcp";
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD");
const symbol = z.string().trim().min(1).max(40).describe("Asset symbol as stored in the app, e.g. BBL (case-insensitive). The asset must already exist");
const metricId = z.number().int().positive().describe("Metric id from list_asset_metrics / create_asset_metric (never guess)");
const observationId = z.number().int().positive().describe("Observation id from get_metric_history");

export interface MetricToolDeps {
  resolveAsset: (symbol: string) => Promise<{ id: number; symbol: string } | null>;
  svc: Pick<
    typeof metricService,
    | "metricsOverview"
    | "createMetric"
    | "updateMetric"
    | "deleteMetric"
    | "addObservation"
    | "updateObservation"
    | "deleteObservation"
    | "listObservations"
    | "listThresholds"
    | "previewThreshold"
    | "addThresholdVersion"
    | "metricSeries"
  >;
}

export const defaultMetricToolDeps: MetricToolDeps = {
  resolveAsset: async (s) => {
    const a = await getAssetBySymbol(s);
    return a ? { id: a.id, symbol: a.symbol } : null;
  },
  svc: metricService,
};

function checkRange(from?: string, to?: string) {
  if (from && to && from > to) throw new MetricError(400, "VALIDATION_ERROR", `ช่วงวันที่กลับด้าน: from ${from} > to ${to}`);
}

/** Tool input shapes (MCP SDK takes a raw shape; refinements are re-run by the full schemas below and in the service). */
export const metricToolInputs = {
  list_asset_metrics: { symbol, includeInactive: z.boolean().default(false).describe("Include archived metrics"), withObservations: z.boolean().default(false).describe("Include every observation (default: summaries only — use get_metric_history for history)") },
  create_asset_metric: { symbol, ...metricDefinitionInput.shape },
  update_asset_metric: { symbol, metricId, ...metricDefinitionPatch.shape },
  delete_asset_metric: { symbol, metricId, confirmName: z.string().min(1).describe("Exact current metric name — permanent delete of the metric, its observations and thresholds") },
  record_metric_observation: { symbol, metricId, ...observationInput.shape },
  update_metric_observation: { symbol, metricId, observationId, ...observationPatch.shape },
  delete_metric_observation: { symbol, metricId, observationId, confirmDelete: z.literal(true).describe("Must be true: permanently deletes this one observation") },
  get_metric_history: { symbol, metricId, from: isoDate.optional(), to: isoDate.optional(), limit: z.number().int().min(1).max(1000).default(200), offset: z.number().int().min(0).default(0) },
  list_metric_thresholds: { symbol, metricId },
  preview_metric_threshold: { symbol, metricId, ...thresholdInput.shape },
  set_metric_threshold: { symbol, metricId, ...thresholdInput.shape },
  get_metric_series: {
    symbol,
    metricIds: z.array(metricId).max(20).optional().describe("Default: all active metrics of the asset"),
    from: isoDate.optional(),
    to: isoDate.optional(),
    mode: z.enum(["actual", "indexed", "change"]).default("actual").describe("actual = raw values; indexed = 100 × value / first value in window (refused when that base ≤ 0); change = % vs previous actual observation (null with reason when undefined)"),
  },
} as const;

type Args<K extends keyof typeof metricToolInputs> = z.infer<z.ZodObject<(typeof metricToolInputs)[K]>>;

/** Handlers (exported for tests with mocked deps). */
export function metricToolHandlers(deps: MetricToolDeps = defaultMetricToolDeps) {
  const asset = async (s: string) => {
    const a = await deps.resolveAsset(s);
    if (!a) throw new MetricError(404, "ASSET_NOT_FOUND", `ไม่พบสินทรัพย์ ${s} — เพิ่มสินทรัพย์ก่อน (ระบบไม่สร้างให้อัตโนมัติ)`);
    return a;
  };
  const { svc } = deps;
  return {
    async list_asset_metrics({ symbol: s, includeInactive, withObservations }: Args<"list_asset_metrics">) {
      const a = await asset(s);
      return { symbol: a.symbol, assetId: a.id, metrics: await svc.metricsOverview(a.id, { includeInactive, withObservations }) };
    },
    async create_asset_metric({ symbol: s, ...definition }: Args<"create_asset_metric">) {
      const a = await asset(s);
      return { symbol: a.symbol, metric: await svc.createMetric(a.id, metricDefinitionInput.parse(definition), SOURCE) };
    },
    async update_asset_metric({ symbol: s, metricId: m, ...patch }: Args<"update_asset_metric">) {
      const a = await asset(s);
      return { symbol: a.symbol, metric: await svc.updateMetric(a.id, m, metricDefinitionPatch.parse(patch), SOURCE) };
    },
    async delete_asset_metric({ symbol: s, metricId: m, confirmName }: Args<"delete_asset_metric">) {
      const a = await asset(s);
      return { symbol: a.symbol, metricId: m, ...(await svc.deleteMetric(a.id, m, confirmName, SOURCE)) };
    },
    async record_metric_observation({ symbol: s, metricId: m, ...obs }: Args<"record_metric_observation">) {
      const a = await asset(s);
      return { symbol: a.symbol, observation: await svc.addObservation(a.id, m, observationInput.parse(obs), SOURCE) };
    },
    async update_metric_observation({ symbol: s, metricId: m, observationId: o, ...patch }: Args<"update_metric_observation">) {
      const a = await asset(s);
      return { symbol: a.symbol, observation: await svc.updateObservation(a.id, m, o, observationPatch.parse(patch), SOURCE) };
    },
    async delete_metric_observation({ symbol: s, metricId: m, observationId: o, confirmDelete }: Args<"delete_metric_observation">) {
      if (confirmDelete !== true) throw new MetricError(403, "CONFIRMATION_REQUIRED", "ต้องส่ง confirmDelete: true เพื่อยืนยันการลบ — ถ้าแค่แก้ค่า ใช้ update_metric_observation");
      const a = await asset(s);
      return { symbol: a.symbol, metricId: m, ...(await svc.deleteObservation(a.id, m, o, SOURCE)) };
    },
    async get_metric_history({ symbol: s, metricId: m, from, to, limit, offset }: Args<"get_metric_history">) {
      checkRange(from, to);
      const a = await asset(s);
      return { symbol: a.symbol, ...(await svc.listObservations(a.id, m, { from, to, limit, offset })) };
    },
    async list_metric_thresholds({ symbol: s, metricId: m }: Args<"list_metric_thresholds">) {
      const a = await asset(s);
      return { symbol: a.symbol, metricId: m, versions: await svc.listThresholds(a.id, m), rule: "a version applies on effectiveFrom ≤ date < effectiveTo (null = open-ended)" };
    },
    async preview_metric_threshold({ symbol: s, metricId: m, ...t }: Args<"preview_metric_threshold">) {
      const a = await asset(s);
      return { symbol: a.symbol, metricId: m, saved: false, ...(await svc.previewThreshold(a.id, m, thresholdInput.parse(t))) };
    },
    async set_metric_threshold({ symbol: s, metricId: m, ...t }: Args<"set_metric_threshold">) {
      const a = await asset(s);
      return { symbol: a.symbol, metricId: m, version: await svc.addThresholdVersion(a.id, m, thresholdInput.parse(t), SOURCE) };
    },
    async get_metric_series({ symbol: s, metricIds, from, to, mode }: Args<"get_metric_series">) {
      checkRange(from, to);
      const a = await asset(s);
      return { symbol: a.symbol, ...(await svc.metricSeries(a.id, { metricIds, from, to, mode })) };
    },
  };
}

type Safe = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

const META: Record<keyof typeof metricToolInputs, { title: string; description: string; readOnly: boolean; destructive?: boolean }> = {
  list_asset_metrics: {
    title: "List asset custom metrics",
    description:
      "User-defined metrics of one asset (e.g. NPL Ratio of BBL) with latest value, status under the threshold in force on that date (GREEN / YELLOW / RED / NO_THRESHOLD / NO_DATA), freshness and threshold versions. Not portfolio performance — that is get_performance_metrics.",
    readOnly: true,
  },
  create_asset_metric: {
    title: "Create asset custom metric",
    description: "Define a new tracked metric for an existing asset (name, unit, frequency …). Returns the metric with its id — use that id afterwards. Duplicate names (after normalisation) → DUPLICATE_METRIC. No values are created.",
    readOnly: false,
  },
  update_asset_metric: {
    title: "Update asset custom metric",
    description: "Edit metadata; isActive false archives (history kept), true restores. Renaming keeps id and history. Changing the unit when values exist needs confirmUnitChange: true — old values are NOT converted.",
    readOnly: false,
  },
  delete_asset_metric: {
    title: "Delete asset custom metric (permanent)",
    description: "PERMANENTLY deletes the metric with all its observations and thresholds (audited). Only when the user explicitly asks; prefer update_asset_metric isActive:false. Requires confirmName = exact metric name.",
    readOnly: false,
    destructive: true,
  },
  record_metric_observation: {
    title: "Record metric value",
    description:
      "Add one dated value: observedOn = period / observation date (not today unless that is the period), value = decimal (0 and negatives allowed), source, publishedOn = first public date only if known. Use only values the user gave or a cited report — never invent data. Existing date → DUPLICATE_OBSERVATION with the existing id; use update_metric_observation instead.",
    readOnly: false,
  },
  update_metric_observation: { title: "Update metric value", description: "Correct an existing observation in place (same id); fields not given are kept.", readOnly: false },
  delete_metric_observation: {
    title: "Delete metric value (permanent)",
    description: "PERMANENTLY deletes the one observation with this id (audited). Requires confirmDelete: true. To correct a value use update_metric_observation.",
    readOnly: false,
    destructive: true,
  },
  get_metric_history: {
    title: "Metric history",
    description: "Observations newest first, paginated (limit ≤ 1000) and filtered by from / to (inclusive). Each has status, explanation and versionId of the threshold in force on its own date.",
    readOnly: true,
  },
  list_metric_thresholds: { title: "Metric threshold versions", description: "Effective-dated green / yellow / red rules of a metric, in the metric's raw unit.", readOnly: true },
  preview_metric_threshold: {
    title: "Preview metric threshold",
    description: "Same input and validation as set_metric_threshold; returns how observations on / after effectiveFrom would be classified. Saves nothing.",
    readOnly: true,
  },
  set_metric_threshold: {
    title: "Set metric threshold (new version)",
    description:
      "User-defined rule in the metric's raw unit (not an official benchmark). lower_is_better: green ≤ greenBound < yellow ≤ yellowBound < red. higher_is_better: red < yellowBound ≤ yellow < greenBound ≤ green. target_range: yellowMin < greenMin ≤ greenMax < yellowMax. effectiveFrom must be after the latest version (which is then closed); versions already in effect are never rewritten.",
    readOnly: false,
  },
  get_metric_series: {
    title: "Metric chart series",
    description: "Chart-ready series for one asset's metrics with unit, dates, raw values and statuses. Gaps stay null; no interpolation; indexed refuses a base ≤ 0; change returns null with a reason when undefined.",
    readOnly: true,
  },
};

/** Register the 12 asset-metric tools on the existing MCP server. */
export function registerAssetMetricTools(server: McpServer, safe: Safe, deps: MetricToolDeps = defaultMetricToolDeps) {
  const h = metricToolHandlers(deps) as unknown as Record<string, (a: unknown) => Promise<unknown>>;
  for (const [name, meta] of Object.entries(META)) {
    server.registerTool(
      name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: metricToolInputs[name as keyof typeof metricToolInputs],
        annotations: meta.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: !!meta.destructive },
      },
      safe((args: unknown) => h[name](args)) as never,
    );
  }
}

export const ASSET_METRIC_TOOL_NAMES = Object.keys(META);
