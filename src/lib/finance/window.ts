/**
 * Lookback window (spec-lookback-window.md) — one request shape for every μ / Σ feature (pure).
 *  - presets 1y … 10y = endDate − N calendar years; max = from the longest history in the universe;
 *    custom = startDate (required) … endDate (≤ 20 years); endDate defaults to the last stored price date.
 *  - legacy lookbackDays = custom (endDate − lookbackDays); sending it together with `window` is WINDOW_CONFLICT.
 *  - windowInfo: requested vs effective period, the assets that shortened it, the ones dropped, and a
 *    quality grade from observations per asset (≥ minObsPerAsset ok, ≥ 3 thin, else insufficient).
 */
import { z } from "zod";

export const WINDOW_PRESETS = ["1y", "2y", "3y", "5y", "7y", "10y", "max", "custom"] as const;
export type WindowPreset = (typeof WINDOW_PRESETS)[number];
export const CUSTOM_MAX_YEARS = 20;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "วันที่ต้องเป็น YYYY-MM-DD");

export const windowInput = z
  .object({
    preset: z.enum(WINDOW_PRESETS).describe("1y … 10y = N calendar years back from endDate; max = all history; custom = startDate … endDate"),
    startDate: isoDate.optional().describe("Required with preset custom"),
    endDate: isoDate
      .optional()
      .describe("Analysis date (default: the last stored price date). Nothing after it is used — prices, FX, benchmark, dividends, valuations"),
    muWindow: z
      .object({ preset: z.enum(WINDOW_PRESETS), startDate: isoDate.optional() })
      .optional()
      .describe("Advanced: a separate (usually longer) period for expected returns; Σ and β keep `window`"),
  })
  .describe(
    "Data period for μ / Σ. Omit = Settings default (3y unless changed). Legacy lookbackDays still works but not together with window",
  );
export type WindowRequest = z.infer<typeof windowInput>;

export type WindowErrorCode = "WINDOW_CONFLICT" | "INVALID_WINDOW";
export class WindowError extends Error {
  constructor(
    public code: WindowErrorCode,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "WindowError";
  }
  get issue() {
    return { code: this.code, suggestion: this.hint };
  }
}

export interface ResolvedWindow {
  preset: WindowPreset;
  /** null = max: from the first price of the longest history. */
  startDate: string | null;
  endDate: string;
  mu: { preset: WindowPreset; startDate: string | null } | null;
}

const minusYears = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
};
const minusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

function startOf(preset: WindowPreset, startDate: string | undefined, endDate: string, field: string): string | null {
  if (preset === "max") return null;
  if (preset === "custom") {
    if (!startDate) throw new WindowError("INVALID_WINDOW", `${field}: preset custom ต้องระบุ startDate`);
    if (startDate >= endDate) throw new WindowError("INVALID_WINDOW", `${field}: startDate (${startDate}) ต้องก่อน endDate (${endDate})`);
    if (startDate < minusYears(endDate, CUSTOM_MAX_YEARS))
      throw new WindowError("INVALID_WINDOW", `${field}: ช่วงกำหนดเองยาวได้ไม่เกิน ${CUSTOM_MAX_YEARS} ปี`, 'ใช้ preset "max" เพื่อใช้ข้อมูลทั้งหมด');
    return startDate;
  }
  return minusYears(endDate, Number(preset.replace("y", "")));
}

export function resolveWindow(
  req: WindowRequest | undefined,
  ctx: { legacyLookbackDays?: number; settingsDefault: WindowPreset; lastPriceDate: string; today: string },
): ResolvedWindow {
  if (req && ctx.legacyLookbackDays != null)
    throw new WindowError("WINDOW_CONFLICT", "ส่งทั้ง window และ lookbackDays — เลือกอย่างใดอย่างหนึ่ง", "ใช้ window (lookbackDays เก็บไว้เพื่อความเข้ากันได้)");
  const endDate = req?.endDate ?? (ctx.lastPriceDate < ctx.today ? ctx.lastPriceDate : ctx.today);
  if (endDate > ctx.today) throw new WindowError("INVALID_WINDOW", `endDate ${endDate} เป็นวันในอนาคต`);
  if (endDate > ctx.lastPriceDate)
    throw new WindowError("INVALID_WINDOW", `endDate ${endDate} อยู่หลังวันที่มีราคาล่าสุด (${ctx.lastPriceDate})`, "เว้น endDate ว่างเพื่อใช้วันที่มีราคาล่าสุด");
  if (!req && ctx.legacyLookbackDays != null)
    return { preset: "custom", startDate: minusDays(endDate, ctx.legacyLookbackDays), endDate, mu: null };
  const preset = req?.preset ?? ctx.settingsDefault;
  const startDate = startOf(preset, req?.startDate, endDate, "window");
  const mu = req?.muWindow ? { preset: req.muWindow.preset, startDate: startOf(req.muWindow.preset, req.muWindow.startDate, endDate, "muWindow") } : null;
  return { preset, startDate, endDate, mu };
}

export type WindowQuality = "ok" | "thin" | "insufficient";

export function windowQuality(obsPerAsset: number, minObsPerAsset = 10): WindowQuality {
  if (obsPerAsset >= minObsPerAsset) return "ok";
  if (obsPerAsset >= 3) return "thin";
  return "insufficient";
}

export interface WindowInfo {
  requested: { preset: WindowPreset; startDate: string | null; endDate: string };
  effective: { startDate: string; endDate: string; observations: number; frequency: string; years: number } | null;
  limitedBy: { symbol: string; firstDate: string }[];
  dropped: { symbol: string; firstDate: string | null; reason: string }[];
  obsPerAsset: number;
  quality: WindowQuality;
  muYears: number;
  sigmaYears: number;
  warnings: string[];
}

const yearsBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / (365.25 * 86_400_000);

export function buildWindowInfo(x: {
  requested: ResolvedWindow;
  /** Start used when the request was "max" (first price of the longest history). */
  maxStart: string | null;
  effective: { startDate: string; endDate: string; observations: number; frequency: string } | null;
  nAssets: number;
  limitedBy: { symbol: string; firstDate: string }[];
  dropped: { symbol: string; firstDate: string | null; reason: string }[];
  muYears?: number | null;
  minObsPerAsset?: number;
}): WindowInfo {
  const reqStart = x.requested.startDate ?? x.maxStart;
  const effYears = x.effective ? yearsBetween(x.effective.startDate, x.effective.endDate) : 0;
  const obsPerAsset = x.effective && x.nAssets > 0 ? x.effective.observations / x.nAssets : 0;
  const quality = windowQuality(obsPerAsset, x.minObsPerAsset ?? 10);
  const warnings: string[] = [];
  const reqYears = reqStart ? yearsBetween(reqStart, x.requested.endDate) : 0;
  if (x.effective && reqYears > 0 && effYears < 0.5 * reqYears)
    warnings.push(
      `ขอ ${reqYears.toFixed(1)} ปี แต่ใช้จริง ${effYears.toFixed(1)} ปี (${x.effective.observations} งวด${x.effective.frequency === "weekly" ? "รายสัปดาห์" : x.effective.frequency === "monthly" ? "รายเดือน" : "รายวัน"})${x.limitedBy.length ? ` เพราะ ${x.limitedBy.map((l) => `${l.symbol} เริ่ม ${l.firstDate}`).join(", ")}` : ""} — historyPolicy "drop_short" ตัดตัวที่ประวัติสั้น`,
    );
  if (quality === "thin")
    warnings.push(`ข้อมูล ${obsPerAsset.toFixed(1)} งวดต่อสินทรัพย์ (ควร ≥ ${x.minObsPerAsset ?? 10}) — Σ ไม่เสถียร แนะนำ covMethod "ledoit_wolf" หรือช่วงข้อมูลยาวขึ้น`);
  if (quality === "insufficient" && x.effective)
    warnings.push(`ข้อมูลเพียง ${obsPerAsset.toFixed(1)} งวดต่อสินทรัพย์ (< 3) — ผลไม่น่าเชื่อถือ: ตัดสินทรัพย์ที่ประวัติสั้น (drop_short), ลดจำนวนสินทรัพย์ หรือใช้ช่วงยาวขึ้น`);
  return {
    requested: { preset: x.requested.preset, startDate: reqStart, endDate: x.requested.endDate },
    effective: x.effective ? { ...x.effective, years: effYears } : null,
    limitedBy: x.limitedBy,
    dropped: x.dropped,
    obsPerAsset,
    quality,
    muYears: x.muYears ?? effYears,
    sigmaYears: effYears,
    warnings,
  };
}

/** Query-string form used by REST GET routes and pages: window=3y | custom, startDate, endDate, muWindow. */
export function windowFromQuery(sp: URLSearchParams): WindowRequest | undefined {
  const preset = sp.get("window");
  if (!preset) return undefined;
  return windowInput.parse({
    preset,
    ...(sp.get("startDate") ? { startDate: sp.get("startDate") } : {}),
    ...(sp.get("endDate") ? { endDate: sp.get("endDate") } : {}),
    ...(sp.get("muWindow") ? { muWindow: { preset: sp.get("muWindow"), ...(sp.get("muStartDate") ? { startDate: sp.get("muStartDate") } : {}) } } : {}),
  });
}

/** Page query (?win=…&from=…&to=…&mu=…) → request; invalid input → undefined plus the reason (never guessed). */
export function windowFromPageQuery(q: { win?: string; from?: string; to?: string; mu?: string }): {
  request: WindowRequest | undefined;
  error: string | null;
} {
  if (!q.win) return { request: undefined, error: null };
  const r = windowInput.safeParse({
    preset: q.win,
    ...(q.from ? { startDate: q.from } : {}),
    ...(q.to ? { endDate: q.to } : {}),
    ...(q.mu ? { muWindow: { preset: q.mu } } : {}),
  });
  return r.success ? { request: r.data, error: null } : { request: undefined, error: r.error.issues.map((i) => i.message).join(" · ") };
}
