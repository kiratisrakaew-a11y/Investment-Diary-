import { analyticsFromPrice, specFromBondAsset } from "@/lib/finance/bonds";
import { today } from "@/lib/validation";
import { listAssets } from "./assets";
import { loadPriceHistory } from "./prices";
import { getPortfolioSummary } from "./portfolio";

/** YTM, duration and convexity for every bond asset that has coupon, maturity and a price. */
export async function bondHoldings() {
  const [assets, prices, summary] = await Promise.all([listAssets(), loadPriceHistory(), getPortfolioSummary()]);
  const settlement = today();
  const rows = assets
    .filter((a) => a.assetClass === "bond")
    .map((a) => {
      const series = prices.get(a.id);
      const last = series?.[series.length - 1];
      const pos = summary.positions.find((p) => p.assetId === a.id);
      const base = {
        id: a.id,
        symbol: a.symbol,
        name: a.name,
        couponRate: a.couponRate,
        maturityDate: a.maturityDate,
        faceValue: a.faceValue,
        lastPrice: last?.[1] ?? null,
        lastPriceDate: last?.[0] ?? null,
        marketValueThb: pos?.marketValueThb ?? 0,
        couponFrequency: a.couponFrequency,
        dayCount: a.dayCount,
        /** Price basis: stored per-unit price is treated as a CLEAN price (× 100 / face); accrued interest is added for the dirty price. */
        priceBasis: "clean_assumed" as const,
        /** Conventions the analytics had to assume because the asset does not store them. */
        assumed: specFromBondAsset(a, settlement).assumed,
      };
      if (a.couponRate == null || !a.maturityDate || !last || a.maturityDate <= settlement) {
        return { ...base, analytics: null, missing: "ต้องมีอัตราคูปอง วันครบกำหนด และราคาล่าสุด" };
      }
      // Prices are stored per unit; convert to per-100-face for yield maths.
      const cleanPer100 = a.faceValue ? (last[1] / a.faceValue) * 100 : last[1];
      try {
        const r = analyticsFromPrice(specFromBondAsset(a, settlement).spec, cleanPer100);
        const { flows: _f, ...analytics } = r;
        return { ...base, analytics, missing: null };
      } catch (e) {
        return { ...base, analytics: null, missing: (e as Error).message };
      }
    });
  const held = rows.filter((r) => r.analytics && r.marketValueThb > 0);
  const total = held.reduce((s, r) => s + r.marketValueThb, 0);
  const portfolio =
    total > 0
      ? {
          marketValueThb: total,
          ytm: held.reduce((s, r) => s + r.analytics!.ytm * r.marketValueThb, 0) / total,
          modifiedDuration: held.reduce((s, r) => s + r.analytics!.modifiedDuration * r.marketValueThb, 0) / total,
          convexity: held.reduce((s, r) => s + r.analytics!.convexity * r.marketValueThb, 0) / total,
        }
      : null;
  return { settlement, bonds: rows, portfolio };
}
