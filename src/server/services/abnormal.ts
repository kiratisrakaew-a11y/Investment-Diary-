/**
 * Abnormal trading — data assembly for one stock: its daily series, the benchmark chosen without
 * mixing bases (adjusted close ↔ total-return index, or close ↔ price index), XD dates and caveats.
 * Calculations are the pure modules in src/lib/finance/abnormal; this layer only loads and labels.
 */
import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { DISCLAIMER, MODEL_LABEL, alignReturns, eventStudy, type EventStudyOptions, type ExpectedModel } from "@/lib/finance/abnormal/returns";
import { MetricError } from "./asset-metrics";
import { getAssetBySymbol } from "./assets";
import { getSettings } from "./settings";
import { listEvents, sharesHistory } from "./stock-data";
import { DEFAULT_THRESHOLDS, rollingVolumeZ, volumeSeries, zeroVolumeShare, type Thresholds } from "@/lib/finance/abnormal/volume";

export const DEFAULT_TRI_SYMBOL = "SETTRI";

export interface StockDay {
  date: string;
  close: number;
  adjClose: number | null;
  volume: number | null;
}

export async function loadStock(symbol: string) {
  const asset = await getAssetBySymbol(symbol);
  if (!asset) throw new MetricError(404, "ASSET_NOT_FOUND", `ไม่พบ ${symbol} ในรายการสินทรัพย์`);
  if (asset.assetClass !== "thai_stock") throw new MetricError(400, "UNSUPPORTED_ASSET", `${asset.symbol} ไม่ใช่หุ้นไทย — ฟีเจอร์นี้รองรับเฉพาะ thai_stock`);
  const P = schema.prices;
  const days: StockDay[] = await getDb().select({ date: P.date, close: P.close, adjClose: P.adjClose, volume: P.volume }).from(P).where(eq(P.assetId, asset.id)).orderBy(asc(P.date));
  return { asset, days };
}

async function benchSeries(symbol: string) {
  const B = schema.benchmarkPrices;
  return (await getDb().select({ date: B.date, close: B.close }).from(B).where(eq(B.symbol, symbol)).orderBy(asc(B.date))).map((r) => [r.date, r.close] as [string, number]);
}

export interface BenchmarkChoice {
  basis: "total_return" | "price";
  symbol: string;
  label: string;
  stock: [string, number][];
  bench: [string, number][];
  warnings: string[];
}

/**
 * TRI is used only when it exists AND the stock has an adjusted close on (almost) every day of it;
 * otherwise close vs the price index. The two bases are never mixed.
 */
export async function chooseBenchmark(days: StockDay[], opts: { triSymbol?: string } = {}): Promise<BenchmarkChoice> {
  const settings = await getSettings();
  const triSymbol = (opts.triSymbol ?? DEFAULT_TRI_SYMBOL).toUpperCase();
  const tri = await benchSeries(triSymbol);
  const warnings: string[] = [];
  if (tri.length) {
    const triDates = new Set(tri.map(([d]) => d));
    const onTri = days.filter((d) => triDates.has(d.date));
    const withAdj = onTri.filter((d) => d.adjClose != null && d.adjClose > 0);
    if (onTri.length && withAdj.length / onTri.length >= 0.95) {
      return { basis: "total_return", symbol: triSymbol, label: `${triSymbol} (Total Return Index) เทียบ adjusted close`, stock: withAdj.map((d) => [d.date, d.adjClose!]), bench: tri, warnings };
    }
    warnings.push(`มี ${triSymbol} แต่หุ้นยังไม่มี adjusted close ครบ (${withAdj.length}/${onTri.length} วัน) — ใช้ราคาปิดเทียบดัชนีราคาแทน (sync ด้วย priceType adjusted_close เพื่อใช้ TRI)`);
  } else {
    warnings.push(`ยังไม่มี ${triSymbol} (SET Total Return Index) — ใช้ราคาปิดเทียบดัชนีราคา ${settings.benchmarkSymbol} ผลตอบแทนวัน XD จะต่ำกว่าจริงตามปันผล`);
  }
  const bench = await benchSeries(settings.benchmarkSymbol);
  if (!bench.length) warnings.push(`ไม่มีข้อมูลดัชนี ${settings.benchmarkSymbol} ในระบบ`);
  return { basis: "price", symbol: settings.benchmarkSymbol, label: `${settings.benchmarkSymbol} (ดัชนีราคา) เทียบราคาปิด`, stock: days.map((d) => [d.date, d.close]), bench, warnings };
}

/** Benchmark history coverage relative to the stock (for clear "not enough data" reasons). */
export function benchmarkCoverage(choice: BenchmarkChoice, days: StockDay[]) {
  const first = choice.bench[0]?.[0] ?? null;
  return { benchmarkFrom: first, benchmarkDays: choice.bench.length, stockFrom: days[0]?.date ?? null, stockDays: days.length };
}

export async function runEventStudy(input: { symbol: string; eventDate?: string; eventId?: number; model?: ExpectedModel; estimationWindow?: [number, number]; eventWindow?: [number, number]; triSymbol?: string }) {
  const { asset, days } = await loadStock(input.symbol);
  let eventDate = input.eventDate;
  let event: { id: number; eventType: string; description: string } | null = null;
  if (input.eventId != null) {
    const [e] = await getDb().select().from(schema.stockEvents).where(and(eq(schema.stockEvents.id, input.eventId), eq(schema.stockEvents.symbol, asset.symbol.toUpperCase())));
    if (!e) throw new MetricError(404, "EVENT_NOT_FOUND", `ไม่พบ event #${input.eventId} ของ ${asset.symbol}`);
    eventDate = e.eventDate;
    event = { id: e.id, eventType: e.eventType, description: e.description };
  }
  if (!eventDate) throw new MetricError(400, "VALIDATION_ERROR", "ต้องระบุ eventDate หรือ eventId");
  const choice = await chooseBenchmark(days, { triSymbol: input.triSymbol });
  const x = alignReturns(choice.stock, choice.bench);
  const xd = (await listEvents({ symbol: asset.symbol, types: ["xd"] })).map((e) => e.eventDate);
  const opts: EventStudyOptions = { eventDate, model: input.model, estimation: input.estimationWindow, event: input.eventWindow, basis: choice.basis, xdDates: xd };
  const r = eventStudy(x, opts);
  const model = input.model ?? "market";
  const common = {
    symbol: asset.symbol,
    model,
    modelLabel: MODEL_LABEL[model],
    benchmark: { basis: choice.basis, symbol: choice.symbol, label: choice.label },
    coverage: { ...benchmarkCoverage(choice, days), commonReturns: x.dates.length, skipped: x.skipped },
    event,
    disclaimer: DISCLAIMER,
  };
  if (!r.ok) return { ...common, ok: false as const, code: r.code, reason: r.reason, warnings: choice.warnings };
  return { ...common, ...r, warnings: [...choice.warnings, ...r.warnings] };
}

/** Daily abnormal volume (mean-adjusted z of log turnover) for one stock over [from, to]. */
export async function getAbnormalVolume(input: { symbol: string; from?: string; to?: string; thresholds?: Partial<Thresholds>; estimationWindow?: [number, number] }) {
  const { asset, days } = await loadStock(input.symbol);
  const shares = await sharesHistory(asset.symbol);
  const s = volumeSeries(days, shares);
  const th = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const rows = rollingVolumeZ(s, { from: input.from, to: input.to, estimation: input.estimationWindow, thresholds: th });
  const zero = zeroVolumeShare(s, input.from, input.to);
  const warnings = [...s.warnings];
  if (!s.dates.length) warnings.push("ยังไม่มีข้อมูล volume — sync_historical_prices อีกครั้งเพื่อดึง volume จาก Yahoo");
  if (zero.thin) warnings.push(`วันที่ volume = 0 มี ${(zero.share * 100).toFixed(1)}% (> 10%) — หุ้นซื้อขายไม่ต่อเนื่อง แนะนำ Dimson beta สำหรับ abnormal return`);
  const lastShares = shares.at(-1) ?? null;
  return {
    symbol: asset.symbol,
    model: "mean_adjusted",
    modelLabel: "Mean-adjusted abnormal volume (Campbell & Wasley 1996)",
    basis: s.basis,
    transform: s.basis === "turnover" ? "V = ln(volume / shares outstanding + 0.00000255)" : "V = ln(volume + 1) (ไม่มีจำนวนหุ้น — ใช้ raw volume)",
    estimationWindow: input.estimationWindow ?? [-250, -30],
    thresholds: th,
    period: { from: rows[0]?.date ?? null, to: rows.at(-1)?.date ?? null, days: rows.length },
    sharesOutstanding: lastShares ? { shares: lastShares.shares, effectiveDate: lastShares.effectiveDate, source: lastShares.source } : null,
    zeroVolume: zero,
    flagged: rows.filter((r) => r.level !== "ปกติ").map((r) => ({ date: r.date, z: r.z, level: r.level, volume: r.volume })),
    days: rows,
    warnings,
    disclaimer: DISCLAIMER,
  };
}
