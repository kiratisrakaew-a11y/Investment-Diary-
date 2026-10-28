/** Shared input schemas for asset custom metrics (service, REST, server actions). */
import { z } from "zod";
import { validateRule } from "./thresholds";

export const FREQUENCIES = ["daily", "monthly", "quarterly", "annual", "irregular"] as const;
export const CHART_COLORS = ["series-1", "series-2", "series-3", "series-4", "series-5", "series-6"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "วันที่ต้องเป็น YYYY-MM-DD").refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, "วันที่ไม่ถูกต้อง");
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** Finite decimal: numbers or numeric strings; kept as the canonical decimal string for `numeric` columns. */
export const decimal = z
  .union([z.number(), z.string().trim()])
  .transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v;
    if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s) || !Number.isFinite(Number(s))) {
      ctx.addIssue({ code: "custom", message: "ต้องเป็นตัวเลขจำกัด" });
      return z.NEVER;
    }
    return typeof v === "number" ? s : s.replace(/^\+/, "");
  });
const optDecimal = decimal.nullish().transform((v) => v ?? null);

/** Key from a display name: lower-case, spaces/punctuation → "_", Thai kept. */
export function metricKey(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

export const metricDefinitionInput = z.object({
  name: text(80).min(1, "ต้องระบุชื่อ"),
  unit: text(30).min(1, "ต้องระบุหน่วย"),
  description: optText(500),
  frequency: z.enum(FREQUENCIES).default("irregular"),
  decimals: z.number().int().min(0).max(8).default(2),
  chartColor: z.enum(CHART_COLORS).nullish().transform((v) => v ?? null),
  sourceDefault: optText(200),
});
export type MetricDefinitionInput = z.input<typeof metricDefinitionInput>;

export const metricDefinitionPatch = metricDefinitionInput.partial().extend({
  isActive: z.boolean().optional(),
  showInChart: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(10_000).optional(),
  /** Required to change the unit once observations exist (values are not converted). */
  confirmUnitChange: z.boolean().optional(),
});

export const observationInput = z.object({
  observedOn: isoDate,
  value: decimal,
  source: optText(200),
  note: optText(1000),
  publishedOn: isoDate.nullish().transform((v) => v ?? null),
});
export type ObservationInput = z.input<typeof observationInput>;
export const observationPatch = observationInput.partial();

export const thresholdInput = z
  .object({
    ruleType: z.enum(["lower_is_better", "higher_is_better", "target_range"]),
    effectiveFrom: isoDate,
    greenBound: optDecimal,
    yellowBound: optDecimal,
    greenMin: optDecimal,
    greenMax: optDecimal,
    yellowMin: optDecimal,
    yellowMax: optDecimal,
    reason: optText(500),
    source: optText(200),
  })
  .superRefine((r, ctx) => {
    for (const m of validateRule(r)) ctx.addIssue({ code: "custom", message: m, path: ["ruleType"] });
  });
export type ThresholdInput = z.input<typeof thresholdInput>;

export const observationQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
