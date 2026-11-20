/**
 * PRICE_BASIS_BENCHMARK_SPEC D5 helpers for the real portfolio's total return (pure).
 *  - adjAssetsForPortfolio: which held assets can be measured on adjusted closes (full adj_close over the dates
 *    they were held); the others stay on closes + recorded dividends (`fallback`, never dropped).
 *  - unrecordedDividends: dividends the adj chain accrued with no recorded dividend near them.
 */
import type { AssetInput, PriceHistory, SeriesPoint, TxInput } from "./portfolio";
import { totalReturnSourceFor } from "./total-return-policy";

const DAY = 86_400_000;

export function adjAssetsForPortfolio(
  assets: (AssetInput & { assetClass: string })[],
  txs: TxInput[],
  prices: PriceHistory,
  adj: PriceHistory,
  end: string,
  actions: (a: AssetInput) => { dividendDates: string[]; splitDates: string[] },
): { assetIds: Set<number>; fallback: { symbol: string; reason: string }[] } {
  const firstTx = new Map<number, string>();
  for (const t of txs)
    if (t.assetId != null && (!firstTx.has(t.assetId) || t.date < firstTx.get(t.assetId)!))
      firstTx.set(t.assetId, t.date);
  const assetIds = new Set<number>();
  const fallback: { symbol: string; reason: string }[] = [];
  for (const a of assets) {
    const start = firstTx.get(a.id);
    if (!start || a.assetClass === "cash") continue;
    const window = (prices.get(a.id) ?? []).filter(([d]) => d >= start && d <= end);
    if (!window.length) continue;
    const adjMap = new Map(adj.get(a.id) ?? []);
    const obs = window.map(([date, close]) => ({ date, close, adjClose: adjMap.get(date) ?? null }));
    const src = totalReturnSourceFor(a, obs, actions(a));
    if (src.ok && src.source === "adjusted_close") assetIds.add(a.id);
    else if (src.ok)
      fallback.push({ symbol: a.symbol, reason: src.note ?? "ใช้ราคาปิด" });
    else
      fallback.push({
        symbol: a.symbol,
        reason: `${src.reason.replace(" — ใช้ราคาปิดแทนไม่ได้", "")} — ใช้ราคาปิดและเงินปันผลที่บันทึกแทน${src.required ? ` (ต้องการ: ${src.required})` : ""}`,
      });
  }
  return { assetIds, fallback };
}

/**
 * Accruals of at least `minYield` (0.1%) of the position's value on one date are dividends the adj chain counted on the ex-date.
 * Each needs a recorded dividend of that asset within [ex − 10 days, ex + 120 days]; otherwise it is reported
 * (still to be paid when the window has not ended yet).
 */
export function unrecordedDividends(
  series: SeriesPoint[],
  txs: TxInput[],
  symbolOf: (assetId: number) => string,
  end: string,
  minYield = 0.001,
): { symbol: string; exDate: string; amount: number; pending: boolean }[] {
  const recorded = txs.filter((t) => t.type === "dividend" && t.assetId != null);
  const out: { symbol: string; exDate: string; amount: number; pending: boolean }[] = [];
  for (const p of series)
    for (const a of p.trAccruals ?? []) {
      if (!(a.base > 0) || a.amount < minYield * a.base) continue;
      const ex = Date.parse(p.date);
      const found = recorded.some(
        (t) => t.assetId === a.assetId && Date.parse(t.date) >= ex - 10 * DAY && Date.parse(t.date) <= ex + 120 * DAY,
      );
      if (!found)
        out.push({
          symbol: symbolOf(a.assetId),
          exDate: p.date,
          amount: a.amount,
          pending: Date.parse(end) < ex + 120 * DAY,
        });
    }
  return out;
}
