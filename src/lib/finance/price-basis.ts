/**
 * PRICE_BASIS_BENCHMARK_SPEC §5: which prices a return-based feature uses (pure).
 *  - price_return  closes (split-adjusted), dividends excluded
 *  - total_return  adjusted closes (splits and dividends)
 * The value used is the request's, else the Settings default, else the feature's own default.
 */
export type ReturnBasis = "price_return" | "total_return";
export const RETURN_BASES: readonly ReturnBasis[] = [
  "price_return",
  "total_return",
] as const;

export const RETURN_BASIS_LABEL: Record<ReturnBasis, string> = {
  price_return: "ราคาปิด (Close)",
  total_return: "ราคาปรับปันผล (Adjusted Close · ผลตอบแทนรวม)",
};
export const RETURN_BASIS_SHORT: Record<ReturnBasis, string> = {
  price_return: "Close",
  total_return: "Adjusted Close",
};

/** Shown under the F1 picker (D5): what each basis means for the real portfolio. */
export const PERF_BASIS_NOTE =
  "Close = ปันผลเข้าเงินสดตามวันจ่ายจริง · Adjusted = ปันผลถูกนับตั้งแต่วัน XD และปันผลที่ไม่ได้บันทึกจะถูกนับด้วย";

export type BasisSource = "request" | "settings" | "feature_default";

export interface ResolvedReturnBasis {
  requested: ReturnBasis | "auto" | null;
  used: ReturnBasis;
  source: BasisSource;
}

export function isReturnBasis(x: unknown): x is ReturnBasis {
  return x === "price_return" || x === "total_return";
}

/** request → Settings → feature default. A null Settings value means the feature ignores Settings (F8). */
export function resolveReturnBasis(
  request: ReturnBasis | null | undefined,
  settingsDefault: ReturnBasis | null | undefined,
  featureDefault: ReturnBasis,
): ResolvedReturnBasis {
  if (request) return { requested: request, used: request, source: "request" };
  if (settingsDefault)
    return { requested: null, used: settingsDefault, source: "settings" };
  return { requested: null, used: featureDefault, source: "feature_default" };
}

/** The shared response block every F1–F9 result carries (§5). */
export interface PriceBasisReport {
  requested: ReturnBasis | "auto" | null;
  used: ReturnBasis;
  source: BasisSource;
  /** Assets measured on closes although total_return was asked (allowed by the asset's policy), with why. */
  fallback: { symbol: string; reason: string }[];
  /** Assets left out because their prices cannot give the asked basis, with why. */
  excluded: { symbol: string; reason: string }[];
}

export function priceBasisReport(
  r: ResolvedReturnBasis,
  fallback: { symbol: string; reason: string }[] = [],
  excluded: { symbol: string; reason: string }[] = [],
): PriceBasisReport {
  return { ...r, fallback, excluded };
}

export interface BenchmarkReport {
  symbol: string;
  kind: "price_index" | "total_return";
  basis: "price" | "total_return";
  wanted: "price" | "total_return";
  source: "default" | "auto" | "explicit";
  warning: string | null;
}

export const BENCHMARK_KIND_LABEL: Record<"price_index" | "total_return", string> =
  {
    price_index: "ดัชนีราคา",
    total_return: "ผลตอบแทนรวม",
  };

/** "ราคา: Adjusted Close · ดัชนี: SETTRI (ผลตอบแทนรวม)" — the line every result page shows. */
export function basisSummaryLine(
  priceBasis: { used: ReturnBasis } | null | undefined,
  benchmark: { symbol: string; kind: "price_index" | "total_return" } | null | undefined,
): string {
  const parts: string[] = [];
  if (priceBasis) parts.push(`ราคา: ${RETURN_BASIS_SHORT[priceBasis.used]}`);
  if (benchmark)
    parts.push(
      `ดัชนี: ${benchmark.symbol} (${BENCHMARK_KIND_LABEL[benchmark.kind]})`,
    );
  return parts.join(" · ");
}
