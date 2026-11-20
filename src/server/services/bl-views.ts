/**
 * MPT_FIX_SPEC P1-7 (4) / BACKTEST_SPEC BT-6: saved valuations as Black–Litterman views, point in time.
 * Loads every saved valuation of the symbols once; `viewsAt` builds the views known at a cutoff.
 */
import { and, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { viewsFromValuations, type SavedValuation } from "@/lib/finance/valuation-views";

export async function loadSavedValuations(symbols: string[]): Promise<SavedValuation[]> {
  if (!symbols.length) return [];
  const rows = await getDb()
    .select({
      symbol: schema.valuations.symbol,
      method: schema.valuations.method,
      createdAt: schema.valuations.createdAt,
      date: schema.valuations.date,
      intrinsicValue: schema.valuations.intrinsicValue,
      result: schema.valuations.result,
    })
    .from(schema.valuations)
    .where(inArray(schema.valuations.symbol, symbols));
  return rows
    .filter((r) => r.intrinsicValue != null && r.intrinsicValue > 0)
    .map((r) => {
      const scen = (r.result as { scenarioAnalysis?: { scenarios?: { value?: number | null }[] } } | null)?.scenarioAnalysis?.scenarios;
      return {
        symbol: r.symbol,
        method: r.method,
        createdTs: r.createdAt.getTime(),
        date: r.date,
        intrinsicValue: r.intrinsicValue!,
        scenarioValues: scen?.map((s) => s.value ?? NaN).filter((v) => Number.isFinite(v) && v > 0),
      };
    });
}

/** Cash dividends per share with ex-date in (asOf − 365 days, asOf], by symbol (trailing, as known then). */
export async function trailingDividends(symbols: string[], from: string, to: string) {
  if (!symbols.length) return new Map<string, { exDate: string; dps: number }[]>();
  const D = schema.dividendEvents;
  const rows = await getDb()
    .select({ symbol: D.symbol, exDate: D.exDate, dps: D.dividendPerShare, cash: D.cashOrStock })
    .from(D)
    .where(and(inArray(D.symbol, symbols), gte(D.exDate, from), lte(D.exDate, to)));
  const out = new Map<string, { exDate: string; dps: number }[]>();
  for (const r of rows)
    if (r.exDate && r.cash === "cash") out.set(r.symbol, [...(out.get(r.symbol) ?? []), { exDate: r.exDate, dps: r.dps }]);
  return out;
}

/** Views known at a cutoff (valuations saved strictly before it), with the trailing yield on total return. */
export function viewsAt(
  symbols: string[],
  saved: SavedValuation[],
  dividends: Map<string, { exDate: string; dps: number }[]>,
  priceAt: (symbol: string, date: string) => number | null,
  cutoff: string,
  opts: { totalReturn: boolean; maxAgeDays?: number; strictlyBefore?: boolean },
) {
  const asOfTs = Date.parse(`${cutoff}T23:59:59Z`);
  const yearAgo = new Date(Date.parse(cutoff) - 365 * 86_400_000).toISOString().slice(0, 10);
  return viewsFromValuations(symbols, saved, (s) => priceAt(s, cutoff), {
    asOfTs: opts.strictlyBefore ? Date.parse(`${cutoff}T00:00:00Z`) : asOfTs,
    asOfDate: cutoff,
    strictlyBefore: opts.strictlyBefore,
    maxAgeDays: opts.maxAgeDays,
    dividendYield: opts.totalReturn
      ? (s) => {
          const p = priceAt(s, cutoff);
          const d = (dividends.get(s) ?? []).filter((x) => x.exDate > yearAgo && x.exDate <= cutoff).reduce((a, x) => a + x.dps, 0);
          return p && p > 0 ? d / p : 0;
        }
      : undefined,
  });
}
