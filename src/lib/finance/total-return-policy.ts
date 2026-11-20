/**
 * MPT_FIX_SPEC P0-A3: how an asset's total return is measured when total_return is requested (pure).
 *  - adj_close            the provider's dividend-adjusted closes cover every date (stocks / ETFs)
 *  - close_no_dividend    gold, or a stock with no dividend and no split in the data period: the close is
 *                         already its total return (stated in a note)
 *  - nav                  a fund with no distribution in the period (accumulating NAV includes returns)
 *  - not usable           anything else — a stock that paid dividends but lacks adj_close is NEVER measured
 *                         on closes silently: it is skipped with the reason.
 * Bonds are handled before this (dirty price + coupons from the bond schedule).
 */
export type AssetReturnBasis =
  | "close"
  | "adj_close"
  | "close_no_dividend"
  | "nav"
  | "bond_schedule"
  /** MPT_FIX_SPEC P0-A6: closes + cash dividends net of withholding tax (dividendWithholding). */
  | "net_dividends";

export type TotalReturnSource =
  | {
      ok: true;
      source: "adjusted_close" | "close";
      basis: AssetReturnBasis;
      note?: string;
    }
  | { ok: false; reason: string; required?: string };

export function totalReturnSourceFor(
  asset: { symbol: string; assetClass: string },
  observations: { date: string; close: number; adjClose: number | null }[],
  actions: { dividendDates: string[]; splitDates: string[] },
): TotalReturnSource {
  if (!observations.length) return { ok: false, reason: "ไม่มีราคาในช่วงนี้" };
  const first = observations[0].date;
  const last = observations[observations.length - 1].date;
  const missing = observations.filter(
    (o) => !(o.adjClose != null && o.adjClose > 0),
  ).length;
  if (missing === 0)
    return { ok: true, source: "adjusted_close", basis: "adj_close" };
  const inRange = (d: string) => d > first && d <= last;
  const divs = actions.dividendDates.filter(inRange).length;
  const splits = actions.splitDates.filter(inRange).length;
  if (asset.assetClass === "gold")
    return {
      ok: true,
      source: "close",
      basis: "close_no_dividend",
      note: `${asset.symbol}: ทองไม่มีปันผล — ผลตอบแทนรวม = ผลตอบแทนจากราคา`,
    };
  if (asset.assetClass === "fund") {
    if (!divs)
      return {
        ok: true,
        source: "close",
        basis: "nav",
        note: `${asset.symbol}: NAV กองทุน (ไม่มีการจ่ายปันผลในช่วงนี้) รวมผลตอบแทนแล้ว`,
      };
    return {
      ok: false,
      reason: `กองทุนจ่ายปันผล ${divs} ครั้งในช่วงนี้ — NAV ไม่รวมปันผลที่จ่ายออก จึงไม่ใช่ผลตอบแทนรวม`,
      required: "ข้อมูลปันผลต่อหน่วยของกองทุน",
    };
  }
  if (
    (asset.assetClass === "thai_stock" || asset.assetClass === "us_stock") &&
    !divs &&
    !splits
  )
    return {
      ok: true,
      source: "close",
      basis: "close_no_dividend",
      note: `${asset.symbol}: ไม่มีปันผล/แตกพาร์ในช่วงข้อมูล (${first} → ${last}) — ใช้ราคาปิดเป็นผลตอบแทนรวม`,
    };
  const why = [
    divs && `ปันผล ${divs} ครั้ง`,
    splits && `แตกพาร์ ${splits} ครั้ง`,
  ]
    .filter(Boolean)
    .join(" และ ");
  return {
    ok: false,
    reason: `ไม่มีราคาปรับปันผล (adj_close) ${missing} จาก ${observations.length} วัน${why ? ` และมี${why}ในช่วงนี้ — ใช้ราคาปิดแทนไม่ได้` : ""}`,
    required: `sync_historical_prices symbols:["${asset.symbol}"] priceType:"adjusted_close"`,
  };
}
