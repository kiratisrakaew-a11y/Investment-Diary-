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
};

const thb = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 });
const dec = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export const fmtThb = (n: number) => `฿${thb.format(Math.round(n))}`;
export const fmtNum = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n) ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
export const fmtQty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
export const fmtPct = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n) ? "–" : `${(n * 100).toFixed(digits)}%`;
export const fmtPctRaw = (n: number | null | undefined, digits = 1) =>
  n == null || !Number.isFinite(n) ? "–" : `${n.toFixed(digits)}%`;
export const fmtRatio = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : dec.format(n));
export const signClass = (n: number | null | undefined) => (n == null ? "" : n > 0 ? "text-pos" : n < 0 ? "text-neg" : "");
