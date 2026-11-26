import type { AssetClass } from "@/db/schema";

export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  thai_stock: "หุ้นไทย",
  us_stock: "หุ้นต่างประเทศ",
  bond: "พันธบัตร/หุ้นกู้",
  fund: "กองทุนรวม",
  gold: "ทองคำ",
  cash: "เงินสด",
};

/** Fixed categorical slot per asset class (colour follows the entity, never its rank). */
export const ASSET_CLASS_COLOR: Record<AssetClass, string> = {
  thai_stock: "var(--series-1)",
  us_stock: "var(--series-2)",
  bond: "var(--series-3)",
  fund: "var(--series-5)",
  gold: "var(--series-4)",
  cash: "var(--series-6)",
};

export const NOTE_TYPE_LABEL: Record<string, string> = {
  idea: "ไอเดีย",
  thesis: "Thesis",
  review: "ทบทวน",
  lesson: "บทเรียน",
  market: "ตลาด",
};

export const TX_TYPE_LABEL: Record<string, string> = {
  buy: "ซื้อ",
  sell: "ขาย",
  dividend: "ปันผล",
  coupon: "ดอกเบี้ย",
  deposit: "ฝากเงิน",
  withdraw: "ถอนเงิน",
  fee: "ค่าธรรมเนียม",
  split: "แตกพาร์ / รวมพาร์",
};

export const METHOD_LABEL: Record<string, string> = {
  dcf_fcff: "DCF-FCFF",
  dcf_fcfe: "DCF-FCFE",
  ddm: "DDM",
  residual_income: "Residual income",
  multiples: "Multiples",
  bond: "Bond",
  sotp: "SOTP",
};

/* ------------------------------------------------------------------------------------------------
 * Number formatting (DESIGN.md · Phase 2). Every displayed number goes through these helpers:
 *  - empty / non-finite → "—" (never 0, NaN, null, undefined)
 *  - negatives use the true minus "−" (U+2212); a value that rounds to zero shows no sign
 *  - thousands separators; fixed decimals per call (price 2, % 1, millions 1)
 *  - units belong in the column header, not in every cell (except ฿ / % symbols where noted)
 * ---------------------------------------------------------------------------------------------- */
export const EMPTY = "—";
export const MINUS = "\u2212";

type Num = number | null | undefined;
const isNum = (n: Num): n is number => n != null && Number.isFinite(n);

/** Grouped fixed-decimal body of |n| plus its sign ("−" | "+" | ""); sign is dropped when it rounds to zero. */
function parts(
  n: number,
  digits: number,
  signed: boolean,
  group: boolean,
): { sign: string; body: string; zero: boolean } {
  const d = Math.max(0, digits);
  const abs = Math.abs(n);
  const fixed = abs.toFixed(d);
  const zero = Number(fixed) === 0;
  const [int, frac] = fixed.split(".");
  const body =
    (group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : int) +
    (frac ? `.${frac}` : "");
  const sign = zero ? "" : n < 0 ? MINUS : signed ? "+" : "";
  return { sign, body, zero };
}

export function formatNumber(
  n: Num,
  digits = 2,
  opts: { signed?: boolean; group?: boolean } = {},
): string {
  if (!isNum(n)) return EMPTY;
  const { sign, body } = parts(n, digits, !!opts.signed, opts.group ?? true);
  return sign + body;
}
/** Fraction → percent: 0.1234 → "12.3%". */
export function formatPercent(
  frac: Num,
  digits = 1,
  opts: { signed?: boolean } = {},
): string {
  if (!isNum(frac)) return EMPTY;
  const { sign, body } = parts(frac * 100, digits, !!opts.signed, true);
  return `${sign}${body}%`;
}
/** Value already in percent units: 12.34 → "12.3%". */
export function formatPercentRaw(
  pct: Num,
  digits = 1,
  opts: { signed?: boolean } = {},
): string {
  if (!isNum(pct)) return EMPTY;
  const { sign, body } = parts(pct, digits, !!opts.signed, true);
  return `${sign}${body}%`;
}
/** Money with a symbol (default ฿, 0 decimals): −฿1,234. For table cells prefer formatNumber + unit in the header. */
export function formatMoney(
  n: Num,
  opts: { digits?: number; symbol?: string; signed?: boolean } = {},
): string {
  if (!isNum(n)) return EMPTY;
  const { sign, body } = parts(n, opts.digits ?? 0, !!opts.signed, true);
  return `${sign}${opts.symbol ?? "฿"}${body}`;
}
/** Value in millions (unit "ล้านบาท" lives in the column header): 1_234_567 → "1.2". */
export function formatMillions(n: Num, digits = 1): string {
  return isNum(n) ? formatNumber(n / 1e6, digits) : EMPTY;
}

export type ChangeDir = "up" | "down" | "flat" | "none";
export interface ChangeView {
  text: string;
  dir: ChangeDir;
  /** Tailwind colour class: positive / negative only for direction (colour is never the only signal — text has ▲▼). */
  className: string;
}
/** Up/down change with ▲▼ and colour: ▲ +1.2% · ▼ −3.4% · — */
export function formatChange(
  n: Num,
  kind: "percent" | "number" | "money" = "percent",
  digits = kind === "percent" ? 1 : kind === "money" ? 0 : 2,
): ChangeView {
  if (!isNum(n)) return { text: EMPTY, dir: "none", className: "text-muted" };
  const body =
    kind === "percent"
      ? formatPercent(n, digits, { signed: true })
      : kind === "money"
        ? formatMoney(n, { digits, signed: true })
        : formatNumber(n, digits, { signed: true });
  const rounded = Number(
    Math.abs(kind === "percent" ? n * 100 : n).toFixed(digits),
  );
  if (rounded === 0)
    return { text: body, dir: "flat", className: "text-muted" };
  return n > 0
    ? { text: `▲ ${body}`, dir: "up", className: "text-pos" }
    : { text: `▼ ${body}`, dir: "down", className: "text-neg" };
}

/** Legacy names (same behaviour, now via the helpers). */
export const fmtThb = (n: Num) => formatMoney(n);
export const fmtNum = (n: Num, digits = 2) => formatNumber(n, digits);
export const fmtQty = (n: Num) =>
  isNum(n)
    ? formatNumber(
        n,
        Number.isInteger(n)
          ? 0
          : Math.min(4, (String(n).split(".")[1] ?? "").length),
      )
    : EMPTY;
export const fmtPct = (n: Num, digits = 1) => formatPercent(n, digits);
export const fmtPctRaw = (n: Num, digits = 1) => formatPercentRaw(n, digits);
export const fmtRatio = (n: Num) => formatNumber(n, 2);
export const signClass = (n: Num) =>
  n == null ? "" : n > 0 ? "text-pos" : n < 0 ? "text-neg" : "";
