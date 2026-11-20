/**
 * MPT_FIX_SPEC P0-A4: does an asset's adjusted-close series agree with its recorded dividends? (pure)
 *   factorₜ = adjₜ / closeₜ ;  implied Dₜ = closeₜ₋₁ × (1 − factorₜ₋₁ / factorₜ)
 * Flags:
 *   ADJ_DIVIDEND_MISMATCH       implied dividend differs from the recorded DPS by > max(5%, 0.01)
 *   ADJ_MISSING_DIVIDEND        a recorded ex-date where the factor does not move
 *   ADJ_UNEXPLAINED_CHANGE      the factor moves on a day with no dividend / split
 *   POSSIBLE_UNRECORDED_SPLIT   a close-to-close jump that looks like a split with none recorded
 * Only dates where both close and adj_close exist are examined; nothing is filled in.
 */
import { detectUnrecordedSplits } from "./price-coverage";

export type AdjFlagCode =
  | "ADJ_DIVIDEND_MISMATCH"
  | "ADJ_MISSING_DIVIDEND"
  | "ADJ_UNEXPLAINED_CHANGE"
  | "POSSIBLE_UNRECORDED_SPLIT";
export interface AdjFlag {
  code: AdjFlagCode;
  date: string;
  message: string;
}

/** Relative factor change below this is rounding in the provider's adj_close (≈ a 0.01% dividend). */
const FACTOR_TOL = 1e-4;

export function checkAdjAgainstDividends(
  symbol: string,
  obs: { date: string; close: number; adjClose: number | null }[],
  dividends: { exDate: string; dps: number }[],
  splitDates: string[],
): AdjFlag[] {
  const rows = obs
    .filter((o) => o.close > 0 && o.adjClose != null && o.adjClose > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const flags: AdjFlag[] = [];
  if (rows.length < 2) return flags;
  const first = rows[0].date;
  const last = rows[rows.length - 1].date;
  const f = rows.map((r) => r.adjClose! / r.close);
  // The trading day an ex-date falls on: first row on / after it (and after the first row).
  const dayOf = (d: string) => rows.findIndex((r, i) => i > 0 && r.date >= d);
  const explained = new Set<number>();
  for (const dv of dividends) {
    if (dv.exDate <= first || dv.exDate > last) continue;
    const t = dayOf(dv.exDate);
    if (t < 1) continue;
    explained.add(t);
    const ratio = f[t - 1] / f[t];
    if (Math.abs(ratio - 1) < FACTOR_TOL) {
      flags.push({
        code: "ADJ_MISSING_DIVIDEND",
        date: rows[t].date,
        message: `${symbol}: ปันผล ${dv.dps} (XD ${dv.exDate}) แต่ adj_close ไม่ได้ปรับ — adj ไม่รวมปันผลนี้`,
      });
      continue;
    }
    const implied = rows[t - 1].close * (1 - ratio);
    if (Math.abs(implied - dv.dps) > Math.max(0.05 * dv.dps, 0.01))
      flags.push({
        code: "ADJ_DIVIDEND_MISMATCH",
        date: rows[t].date,
        message: `${symbol}: ปันผลโดยนัยจาก adj_close ${implied.toFixed(4)} ต่างจากที่บันทึก ${dv.dps} (XD ${dv.exDate})`,
      });
  }
  const splitDays = new Set(splitDates.map(dayOf).filter((t) => t > 0));
  for (let t = 1; t < rows.length; t++) {
    if (explained.has(t) || splitDays.has(t)) continue;
    const ratio = f[t - 1] / f[t];
    if (Math.abs(ratio - 1) >= FACTOR_TOL)
      flags.push({
        code: "ADJ_UNEXPLAINED_CHANGE",
        date: rows[t].date,
        message: `${symbol}: adj_close เปลี่ยนฐาน ${((1 - ratio) * 100).toFixed(3)}% ในวัน ${rows[t].date} โดยไม่มีปันผล/แตกพาร์ที่บันทึกไว้`,
      });
  }
  for (const s of detectUnrecordedSplits(
    rows.map((r) => [r.date, r.close] as [string, number]),
    splitDates,
  ))
    flags.push({
      code: "POSSIBLE_UNRECORDED_SPLIT",
      date: s.date,
      message: `${symbol}: ราคาปิดกระโดด ${s.date} เหมือนแตกพาร์ (≈${s.factor >= 1 ? `1:${+s.factor.toFixed(2)}` : `${+(1 / s.factor).toFixed(2)}:1`}) แต่ไม่มีบันทึก`,
    });
  return flags;
}

export interface AdjReadinessAsset {
  symbol: string;
  assetClass: string;
  obs: { date: string; close: number; adjClose: number | null }[];
  dividends: { exDate: string; dps: number }[];
  splitDates: string[];
}

/**
 * MPT_FIX_SPEC P0-A5: adj_close readiness for total return, per asset that needs it (A3: stocks / ETFs
 * whose close is not already their total return). Coverage over the given window + the A4 flags.
 */
export function adjReadiness(assets: AdjReadinessAsset[]) {
  const rows = assets.flatMap((a) => {
    if (!a.obs.length) return [];
    const first = a.obs[0].date;
    const last = a.obs[a.obs.length - 1].date;
    const withAdj = a.obs.filter(
      (o) => o.adjClose != null && o.adjClose > 0,
    ).length;
    const events =
      a.dividends.filter((d) => d.exDate > first && d.exDate <= last).length +
      a.splitDates.filter((d) => d > first && d <= last).length;
    const stock = a.assetClass === "thai_stock" || a.assetClass === "us_stock";
    // Gold, funds and stocks without dividends / splits do not need adj_close (A3).
    if (!stock || (withAdj === 0 && events === 0)) return [];
    const flags = checkAdjAgainstDividends(
      a.symbol,
      a.obs,
      a.dividends,
      a.splitDates,
    );
    return [
      {
        symbol: a.symbol,
        days: a.obs.length,
        withAdjClose: withAdj,
        coverage: withAdj / a.obs.length,
        flags,
      },
    ];
  });
  const missing = rows.filter((r) => r.coverage < 1);
  const flagged = rows.filter((r) => r.flags.length);
  return {
    assets: rows,
    missing: missing.map((r) => r.symbol),
    flagged: flagged.map((r) => r.symbol),
    ok: !missing.length && !flagged.length,
  };
}
export type AdjReadiness = ReturnType<typeof adjReadiness>;
