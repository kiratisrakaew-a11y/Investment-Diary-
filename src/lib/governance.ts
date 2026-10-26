/**
 * Assumption governance: model version, provenance of market inputs, percent-scale
 * guards, valuation import/export and a data-quality assessment shared by the
 * dashboard, settings page, MCP and REST.
 */
import { valuationInput, type ValuationInput } from "./valuation-schemas";
import type { InputMeta } from "./finance/valuation";

export { rateScaleWarnings } from "./rate-scale";

/**
 * Version of the valuation / analytics formulas. Saved valuations record it so a
 * stored value computed under older formulas can be recognised.
 * 2026.10-pr5: ledger & performance (PR 1), DCF terminal/mid-year (PR 2),
 * exact optimizer (PR 3), bond conventions (PR 4), provenance (PR 5).
 */
export const MODEL_VERSION = "2026.10-pr5";

export interface ProvenanceSettings {
  riskFreeRate: number;
  equityRiskPremium: number;
  rfSource: string | null;
  rfAsOf: string | null;
  rfSeries: string | null;
  erpSource: string | null;
  erpAsOf: string | null;
}

export interface InputProvenance {
  /** Decimal value used by the engine. */
  value: number;
  source: string | null;
  asOf: string | null;
  illustrative: boolean;
  label: string;
}

/** Rf / ERP with their source; inputs without a source are labelled illustrative, never "market". */
export function marketInputProvenance(s: ProvenanceSettings) {
  const make = (value: number, source: string | null, asOf: string | null, series?: string | null): InputProvenance => {
    const src = [source, series].filter(Boolean).join(" · ");
    const illustrative = !source;
    return {
      value: value / 100,
      source: src || null,
      asOf,
      illustrative,
      label: illustrative ? "ค่าตัวอย่าง — ยังไม่ได้ระบุแหล่งที่มา" : `${src}${asOf ? ` (ณ ${asOf})` : ""}`,
    };
  };
  return {
    riskFree: make(s.riskFreeRate, s.rfSource, s.rfAsOf, s.rfSeries),
    erp: make(s.equityRiskPremium, s.erpSource, s.erpAsOf),
  };
}

/** Source notes copied into a new valuation's `inputMeta` (left empty when unsourced, so they show as illustrative). */
export function defaultInputMeta(s: ProvenanceSettings, beta: { beta: number; observations: number; benchmark: string } | null): InputMeta {
  const p = marketInputProvenance(s);
  return {
    asOf: s.rfAsOf ?? s.erpAsOf ?? undefined,
    rfSource: p.riskFree.illustrative ? undefined : `ตั้งค่า: ${p.riskFree.source}`,
    erpSource: p.erp.illustrative ? undefined : (s.erpSource ?? undefined),
    betaSource: beta ? `ประมาณจากผลตอบแทนรายวัน ${beta.observations} วันเทียบ ${beta.benchmark} (β ${beta.beta.toFixed(2)})` : undefined,
  };
}

// ------------------------------------------------------------------ import / export

export const VALUATION_FILE_FORMAT = "investment-diary/valuation";

export interface ValuationFile {
  format: typeof VALUATION_FILE_FORMAT;
  version: 1;
  modelVersion: string;
  exportedAt: string;
  symbol: string;
  title: string;
  note: string;
  valuation: ValuationInput;
}

export function exportValuationFile(v: { symbol: string; title?: string; note?: string; valuation: ValuationInput }): ValuationFile {
  return {
    format: VALUATION_FILE_FORMAT,
    version: 1,
    modelVersion: MODEL_VERSION,
    exportedAt: new Date().toISOString(),
    symbol: v.symbol,
    title: v.title ?? "",
    note: v.note ?? "",
    valuation: v.valuation,
  };
}

export type ValuationImport =
  | { ok: true; symbol: string | null; title: string; note: string; modelVersion: string | null; valuation: ValuationInput }
  | { ok: false; error: string };

/** Accepts an exported file or a bare { method, assumptions }; validates and fills defaults for newer fields. */
export function parseValuationImport(text: string): ValuationImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "ไฟล์ไม่ใช่ JSON ที่ถูกต้อง" };
  }
  const obj = raw as Partial<ValuationFile> & { method?: unknown; assumptions?: unknown };
  const candidate = obj && typeof obj === "object" && "valuation" in obj ? obj.valuation : obj;
  const parsed = valuationInput.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `ข้อมูลไม่ถูกต้อง: ${first ? `${first.path.join(".")} — ${first.message}` : "รูปแบบไม่ตรง"}` };
  }
  return {
    ok: true,
    symbol: typeof obj.symbol === "string" ? obj.symbol : null,
    title: typeof obj.title === "string" ? obj.title : "",
    note: typeof obj.note === "string" ? obj.note : "",
    modelVersion: typeof obj.modelVersion === "string" ? obj.modelVersion : null,
    valuation: parsed.data,
  };
}

// ------------------------------------------------------------------ data quality

export type CheckStatus = "ok" | "warn" | "error";

export interface DataQualityCheck {
  area: string;
  status: CheckStatus;
  message: string;
  href?: string;
}

export interface DataQualityInput {
  provenance: ReturnType<typeof marketInputProvenance>;
  positions: { symbol: string; priceStatus: string; priceAgeDays: number | null; fxStatus: string }[];
  reconciliation: { navMatches: boolean; inferredContributionsThb: number };
  ledgerIssues: { code: string; severity: string; message: string }[];
  benchmark: { symbol: string; lastDate: string | null; kind: "price_index" | "total_return" };
  today: string;
  valuations: { id: number; symbol: string; modelVersion?: string }[];
  bonds: { symbol: string; conventionsSet: boolean }[];
}

/** One list of everything that can make a number on screen unreliable, with where to fix it. */
export function assessDataQuality(d: DataQualityInput) {
  const checks: DataQualityCheck[] = [];
  const add = (area: string, bad: boolean, status: CheckStatus, message: string, okMessage: string, href?: string) =>
    checks.push(bad ? { area, status, message, href } : { area, status: "ok", message: okMessage, href });

  const stale = d.positions.filter((p) => p.priceStatus === "stale");
  const noPrice = d.positions.filter((p) => p.priceStatus === "missing" || p.priceStatus === "tx_price_fallback");
  add(
    "ราคา",
    stale.length + noPrice.length > 0,
    noPrice.some((p) => p.priceStatus === "missing") ? "error" : "warn",
    [stale.length && `ราคาเก่า: ${stale.map((p) => `${p.symbol} (${p.priceAgeDays} วัน)`).join(", ")}`, noPrice.length && `ไม่มีราคาตลาด: ${noPrice.map((p) => p.symbol).join(", ")}`]
      .filter(Boolean)
      .join(" · "),
    "ทุกสินทรัพย์มีราคาล่าสุดภายในเกณฑ์",
    "/holdings",
  );
  const fx = d.positions.filter((p) => p.fxStatus === "stale" || p.fxStatus === "tx_fallback");
  add("อัตราแลกเปลี่ยน", fx.length > 0, "warn", `USDTHB ไม่ครบ/เก่า: ${fx.map((p) => p.symbol).join(", ")}`, "USDTHB ครบ", "/holdings");
  const ill = [d.provenance.riskFree.illustrative && "Risk-free rate", d.provenance.erp.illustrative && "ERP"].filter(Boolean);
  add("สมมติฐานตลาด", ill.length > 0, "warn", `${ill.join(" และ ")} ยังเป็นค่าตัวอย่าง — ระบุแหล่งที่มาและวันที่ในหน้าตั้งค่า`, "Rf และ ERP มีแหล่งที่มาและวันที่", "/settings");
  add(
    "เงินสด",
    !d.reconciliation.navMatches || d.reconciliation.inferredContributionsThb > 0,
    d.reconciliation.navMatches ? "warn" : "error",
    d.reconciliation.navMatches
      ? `มีเงินฝากที่ระบบอนุมาน ${Math.round(d.reconciliation.inferredContributionsThb).toLocaleString()} บาท — บันทึกการฝากเงินจริง`
      : "NAV ไม่ตรงกับเงินสด + มูลค่าสินทรัพย์",
    "เงินสดและ NAV กระทบยอดตรงกัน",
    "/transactions",
  );
  const ledger = d.ledgerIssues.filter((i) => i.code !== "STALE_PRICE" && i.code !== "TX_PRICE_FALLBACK" && i.code !== "MISSING_PRICE" && i.code !== "FX_FALLBACK" && i.code !== "INSUFFICIENT_CASH");
  add("รายการ", ledger.length > 0, ledger.some((i) => i.severity === "error") ? "error" : "warn", ledger.map((i) => i.message).slice(0, 3).join(" · "), "ไม่พบรายการผิดปกติ", "/transactions");
  const benchAge = d.benchmark.lastDate ? (Date.parse(d.today) - Date.parse(d.benchmark.lastDate)) / 86_400_000 : Infinity;
  add(
    "ดัชนีอ้างอิง",
    benchAge > 7 || d.benchmark.kind === "price_index",
    "warn",
    [benchAge > 7 && (d.benchmark.lastDate ? `${d.benchmark.symbol} ข้อมูลล่าสุด ${d.benchmark.lastDate}` : `ไม่มีข้อมูล ${d.benchmark.symbol}`), d.benchmark.kind === "price_index" && "เป็นดัชนีราคา (ไม่รวมปันผล) — การเทียบเอียงเข้าข้างพอร์ต"]
      .filter(Boolean)
      .join(" · "),
    `${d.benchmark.symbol} เป็นดัชนีผลตอบแทนรวมและเป็นปัจจุบัน`,
    "/settings",
  );
  const old = d.valuations.filter((v) => v.modelVersion !== MODEL_VERSION);
  add("Valuation", old.length > 0, "warn", `${old.length} รายการบันทึกด้วยสูตรเวอร์ชันก่อน (${[...new Set(old.map((v) => v.symbol))].join(", ")}) — เปิดแล้วบันทึกใหม่เพื่ออัปเดต`, "ทุก valuation ใช้สูตรเวอร์ชันปัจจุบัน", "/valuation");
  const bondsMissing = d.bonds.filter((b) => !b.conventionsSet);
  add("พันธบัตร", bondsMissing.length > 0, "warn", `ยังไม่ระบุความถี่คูปอง/day count: ${bondsMissing.map((b) => b.symbol).join(", ")} — ใช้ค่าสมมติ ทุก 6 เดือน ACT/ACT`, "พันธบัตรทุกตัวระบุเงื่อนไขแล้ว", "/holdings");

  const status: "ok" | "warnings" | "errors" = checks.some((c) => c.status === "error") ? "errors" : checks.some((c) => c.status === "warn") ? "warnings" : "ok";
  return { status, checks, modelVersion: MODEL_VERSION };
}
