/**
 * Analyst consensus target prices (pure). Other people's opinion — shown beside the user's own
 * valuations, never averaged into them. Values are taken as published: nothing is guessed or filled.
 */
import { z } from "zod";
import { isoDate } from "./validation";

export const RECOMMENDATIONS = ["strong_buy", "buy", "hold", "underperform", "sell"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  strong_buy: "ซื้อ (แนะนำมาก)",
  buy: "ซื้อ",
  hold: "ถือ",
  underperform: "ต่ำกว่าตลาด",
  sell: "ขาย",
};

export const CONSENSUS_SOURCE_LABEL: Record<string, string> = { yahoo: "Yahoo Finance", manual: "กรอกเอง", mcp: "บันทึกโดย AI / API" };

/** Older than this the card says so (targets are usually revised after each earnings season). */
export const CONSENSUS_STALE_DAYS = 90;

const price = z.number().positive().finite();

/** Manual / AI entry. At least a mean or a median target; low ≤ mean, median ≤ high. */
export const consensusInput = z
  .object({
    symbol: z.string().trim().min(1).max(40),
    asOf: isoDate.describe("Date of the consensus / report (YYYY-MM-DD), not today unless that is the report date"),
    sourceNote: z.string().trim().min(1, "ต้องระบุแหล่งที่มา").max(200).describe("Where the figures come from, e.g. broker name or 'SET consensus'"),
    currency: z.string().trim().toUpperCase().length(3).optional(),
    targetMean: price.optional(),
    targetMedian: price.optional(),
    targetHigh: price.optional(),
    targetLow: price.optional(),
    analysts: z.number().int().min(0).max(1000).optional(),
    recommendationKey: z.enum(RECOMMENDATIONS).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.targetMean == null && v.targetMedian == null) ctx.addIssue({ code: "custom", message: "ต้องมีราคาเป้าหมายเฉลี่ยหรือมัธยฐานอย่างน้อยหนึ่งค่า", path: ["targetMean"] });
    if (v.targetLow != null && v.targetHigh != null && v.targetLow > v.targetHigh) ctx.addIssue({ code: "custom", message: "ราคาต่ำสุดมากกว่าราคาสูงสุด", path: ["targetLow"] });
    for (const [k, label] of [
      ["targetMean", "เป้าหมายเฉลี่ย"],
      ["targetMedian", "เป้าหมายมัธยฐาน"],
    ] as const) {
      const x = v[k];
      if (x == null) continue;
      if (v.targetLow != null && x < v.targetLow) ctx.addIssue({ code: "custom", message: `${label}ต่ำกว่าราคาต่ำสุด`, path: [k] });
      if (v.targetHigh != null && x > v.targetHigh) ctx.addIssue({ code: "custom", message: `${label}สูงกว่าราคาสูงสุด`, path: [k] });
    }
  });
export type ConsensusInput = z.input<typeof consensusInput>;

/** The subset of Yahoo quoteSummary we read (financialData + price). */
export interface YahooConsensusSource {
  financialData?: {
    currentPrice?: number | null;
    targetMeanPrice?: number | null;
    targetMedianPrice?: number | null;
    targetHighPrice?: number | null;
    targetLowPrice?: number | null;
    numberOfAnalystOpinions?: number | null;
    recommendationKey?: string | null;
    recommendationMean?: number | null;
    financialCurrency?: string | null;
  } | null;
  price?: { currency?: string | null; regularMarketPrice?: number | null } | null;
}

export interface ConsensusFigures {
  currency: string | null;
  targetMean: number | null;
  targetMedian: number | null;
  targetHigh: number | null;
  targetLow: number | null;
  analysts: number | null;
  recommendationKey: Recommendation | null;
  recommendationMean: number | null;
  priceAtFetch: number | null;
}

const pos = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? v : null);

/** Yahoo → figures. No target at all → NO_COVERAGE (nothing to store, nothing invented). */
export function fromYahoo(r: YahooConsensusSource): { ok: true; figures: ConsensusFigures } | { ok: false; code: "NO_COVERAGE"; message: string } {
  const f = r.financialData ?? {};
  const mean = pos(f.targetMeanPrice);
  const median = pos(f.targetMedianPrice);
  if (mean == null && median == null) return { ok: false, code: "NO_COVERAGE", message: "Yahoo ไม่มีราคาเป้าหมายของนักวิเคราะห์สำหรับหุ้นนี้" };
  let high = pos(f.targetHighPrice);
  let low = pos(f.targetLowPrice);
  // An inconsistent range is dropped rather than repaired.
  if (high != null && low != null && low > high) high = low = null;
  const key = (f.recommendationKey ?? "").toLowerCase().replace(/\s+/g, "_");
  const rec = (RECOMMENDATIONS as readonly string[]).includes(key) ? (key as Recommendation) : key === "strongbuy" ? "strong_buy" : null;
  const n = f.numberOfAnalystOpinions;
  const rm = f.recommendationMean;
  return {
    ok: true,
    figures: {
      currency: r.price?.currency ?? null,
      targetMean: mean,
      targetMedian: median,
      targetHigh: high,
      targetLow: low,
      analysts: n != null && Number.isInteger(n) && n >= 0 ? n : null,
      recommendationKey: rec,
      recommendationMean: rm != null && Number.isFinite(rm) && rm >= 1 && rm <= 5 ? rm : null,
      priceAtFetch: pos(f.currentPrice) ?? pos(r.price?.regularMarketPrice),
    },
  };
}

export interface ConsensusRowLike {
  asOf: string;
  createdAt: Date | string;
}

/** Latest by as-of date, then by when it was stored. */
export function pickLatest<T extends ConsensusRowLike>(rows: T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!best || r.asOf > best.asOf || (r.asOf === best.asOf && new Date(r.createdAt).getTime() > new Date(best.createdAt).getTime())) best = r;
  }
  return best;
}

export interface ConsensusView {
  /** Mean when published, otherwise median. */
  target: number;
  targetBasis: "mean" | "median";
  upside: number | null;
  ageDays: number;
  stale: boolean;
  warnings: string[];
}

/** Headline numbers for display: target, upside vs the last stored price, age and caveats. */
export function consensusView(
  row: { asOf: string; targetMean: number | null; targetMedian: number | null; currency: string | null },
  ctx: { price: number | null; priceCurrency?: string | null; today: string },
): ConsensusView {
  const target = (row.targetMean ?? row.targetMedian) as number;
  const ageDays = Math.max(0, Math.round((Date.parse(ctx.today) - Date.parse(row.asOf)) / 86_400_000));
  const warnings: string[] = [];
  const mismatch = !!(row.currency && ctx.priceCurrency && row.currency.toUpperCase() !== ctx.priceCurrency.toUpperCase());
  if (mismatch) warnings.push(`ราคาเป้าหมายเป็น ${row.currency} แต่ราคาในระบบเป็น ${ctx.priceCurrency} — ไม่คำนวณ upside`);
  const stale = ageDays > CONSENSUS_STALE_DAYS;
  if (stale) warnings.push(`ข้อมูลเก่า ${ageDays} วัน — ราคาเป้าหมายอาจถูกปรับไปแล้ว`);
  return {
    target,
    targetBasis: row.targetMean != null ? "mean" : "median",
    upside: !mismatch && ctx.price != null && ctx.price > 0 ? target / ctx.price - 1 : null,
    ageDays,
    stale,
    warnings,
  };
}
