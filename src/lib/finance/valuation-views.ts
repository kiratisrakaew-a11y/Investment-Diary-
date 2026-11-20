/**
 * MPT_FIX_SPEC P1-7 (4): Black–Litterman absolute views from saved valuations (pure).
 *  - the latest valuation per method saved by `asOf` (strictly before it when `strictlyBefore`), not older than
 *    `maxAgeDays`; fair value = median across methods (base case of a scenario set when present);
 *  - view return = FV / price − 1 (+ trailing dividend yield on a total-return basis), over a 1-year horizon;
 *  - confidence from the bear–bull width of the scenario values (or the spread between methods):
 *    c = clamp(0.05, 0.8, 1 / (1 + 2·width)), width = (max − min) / FV; one method without scenarios → 0.25.
 */
import type { BlView } from "./black-litterman";

export interface SavedValuation {
  symbol: string;
  method: string;
  /** Save time (ms) — point in time. */
  createdTs: number;
  date: string;
  intrinsicValue: number;
  /** Scenario values per share (bear … bull) when the valuation had a scenario set. */
  scenarioValues?: number[];
}

export interface ValuationViewsResult {
  views: BlView[];
  used: { symbol: string; fairValue: number; price: number; viewReturn: number; confidence: number; valuationDate: string; methods: string[] }[];
  skipped: { symbol: string; reason: string }[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function viewsFromValuations(
  symbols: string[],
  valuations: SavedValuation[],
  priceOf: (symbol: string) => number | null,
  opts: {
    asOfTs: number;
    asOfDate: string;
    strictlyBefore?: boolean;
    maxAgeDays?: number;
    dividendYield?: (symbol: string) => number;
  },
): ValuationViewsResult {
  const maxAge = opts.maxAgeDays ?? 90;
  const views: BlView[] = [];
  const used: ValuationViewsResult["used"] = [];
  const skipped: ValuationViewsResult["skipped"] = [];
  for (const sym of symbols) {
    const known = valuations.filter(
      (v) => v.symbol.toUpperCase() === sym.toUpperCase() && (opts.strictlyBefore ? v.createdTs < opts.asOfTs : v.createdTs <= opts.asOfTs) && v.intrinsicValue > 0,
    );
    if (!known.length) continue; // no valuation → no view (not a warning)
    const latest = new Map<string, SavedValuation>();
    for (const v of known) {
      const cur = latest.get(v.method);
      if (!cur || v.createdTs > cur.createdTs) latest.set(v.method, v);
    }
    const fresh = [...latest.values()].filter((v) => (opts.asOfTs - v.createdTs) / 86_400_000 <= maxAge);
    if (!fresh.length) {
      const newest = [...latest.values()].sort((a, b) => b.createdTs - a.createdTs)[0];
      skipped.push({ symbol: sym, reason: `valuation ล่าสุด ${newest.date} เก่ากว่า ${maxAge} วัน — ไม่ใช้เป็น view` });
      continue;
    }
    const price = priceOf(sym);
    if (!(price != null && price > 0)) {
      skipped.push({ symbol: sym, reason: `ไม่มีราคา ณ ${opts.asOfDate}` });
      continue;
    }
    const fv = median(fresh.map((v) => v.intrinsicValue));
    const scen = fresh.flatMap((v) => v.scenarioValues ?? []).filter((x) => x > 0);
    const spread = scen.length >= 2 ? scen : fresh.length >= 2 ? fresh.map((v) => v.intrinsicValue) : null;
    const width = spread ? (Math.max(...spread) - Math.min(...spread)) / fv : null;
    const confidence = width == null ? 0.25 : Math.min(0.8, Math.max(0.05, 1 / (1 + 2 * width)));
    const viewReturn = fv / price - 1 + (opts.dividendYield?.(sym) ?? 0);
    views.push({ type: "absolute", symbol: sym, return: viewReturn, confidence });
    used.push({
      symbol: sym,
      fairValue: fv,
      price,
      viewReturn,
      confidence,
      valuationDate: fresh.map((v) => v.date).sort().slice(-1)[0],
      methods: fresh.map((v) => v.method),
    });
  }
  return { views, used, skipped };
}
