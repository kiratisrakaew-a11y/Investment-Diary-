import { z } from "zod";
import { analyticsFromPrice, specFromBondAsset } from "@/lib/finance/bonds";
import { bondLadder, type LadderCandidate } from "@/lib/finance/bond-ladder";
import { today } from "@/lib/validation";
import { listAssets } from "./assets";
import { loadPriceHistory } from "./prices";
import { getPortfolioSummary } from "./portfolio";
import { getSettings, getYieldCurve } from "./settings";
import { bondCredit, creditProfileSchema } from "@/lib/finance/credit-risk";

/** YTM, duration and convexity for every bond asset that has coupon, maturity and a price. */
export async function bondHoldings() {
  const [assets, prices, summary, curve, settings] = await Promise.all([listAssets(), loadPriceHistory(), getPortfolioSummary(), getYieldCurve(), getSettings()]);
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
        issuer: a.issuer,
        /** Conventions the analytics had to assume because the asset does not store them. */
        assumed: specFromBondAsset(a, settlement).assumed,
      };
      if (a.couponRate == null || !a.maturityDate || !last || a.maturityDate <= settlement) {
        return { ...base, analytics: null, credit: null, missing: "ต้องมีอัตราคูปอง วันครบกำหนด และราคาล่าสุด" };
      }
      // Prices are stored per unit; convert to per-100-face for yield maths.
      const cleanPer100 = a.faceValue ? (last[1] / a.faceValue) * 100 : last[1];
      try {
        const spec = specFromBondAsset(a, settlement).spec;
        const r = analyticsFromPrice(spec, cleanPer100);
        const { flows: _f, ...analytics } = r;
        const profile = creditProfileSchema.safeParse(a.credit ?? {});
        const credit = bondCredit(spec, cleanPer100, profile.success ? profile.data : null, {
          curve: curve?.points ?? null,
          curveLabel: curve ? `${curve.source} (${curve.asOf})` : undefined,
          flatRate: settings.riskFreeRate / 100,
          flatLabel: `Rf คงที่ ${settings.riskFreeRate}% จากหน้าตั้งค่า (ไม่มี yield curve)`,
        });
        return { ...base, analytics, credit, missing: null };
      } catch (e) {
        return { ...base, analytics: null, credit: null, missing: (e as Error).message };
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

// ------------------------------------------------------------------ bond ladder (Strategies Phase 4)

export const bondLadderInput = z.object({
  budget: z.number().positive().describe("THB to allocate across the ladder"),
  rungs: z.number().int().min(1).max(15).default(5).describe("Number of yearly maturity buckets (1–N years)"),
  symbols: z.array(z.string()).optional().describe("Candidate bonds (default: every bond asset with terms and a price)"),
  maxPerIssuer: z.number().gt(0).max(1).nullable().default(null),
  maxOneYearPd: z.number().min(0).max(1).nullable().default(null).describe("Exclude bonds whose 1-year PD (from the credit profile) is higher"),
  minRating: z.string().nullable().default(null).describe("Lowest acceptable rating on the AAA … D scale, e.g. BBB-"),
  allowUnrated: z.boolean().default(false),
  reinvestRate: z.number().min(0).max(0.3).nullable().default(null).describe("Assumed reinvestment rate for money received (scenario only)"),
  maxPriceAgeDays: z.number().int().min(1).max(365).default(10),
});

/** Forward bond-ladder plan from the app's bond assets (no historical bond backtest). Read-only. */
export async function planBondLadder(input: z.input<typeof bondLadderInput>) {
  const x = bondLadderInput.parse(input);
  const settlement = today();
  const [assets, prices] = await Promise.all([listAssets(), loadPriceHistory()]);
  const want = x.symbols?.map((s) => s.toUpperCase());
  const missing: { symbol: string; reason: string }[] = [];
  const candidates: LadderCandidate[] = [];
  for (const a of assets.filter((v) => v.assetClass === "bond" && (!want || want.includes(v.symbol.toUpperCase())))) {
    const last = prices.get(a.id)?.at(-1);
    if (a.couponRate == null || !a.maturityDate || !last || a.maturityDate <= settlement || !a.faceValue) {
      missing.push({ symbol: a.symbol, reason: "ต้องมีอัตราคูปอง วันครบกำหนด มูลค่าที่ตราไว้ และราคาล่าสุด" });
      continue;
    }
    const profile = creditProfileSchema.safeParse(a.credit ?? {});
    candidates.push({
      symbol: a.symbol,
      issuer: a.issuer,
      faceValue: a.faceValue,
      cleanPer100: (last[1] / a.faceValue) * 100,
      spec: specFromBondAsset(a, settlement).spec,
      credit: profile.success && (profile.data.rating || profile.data.pd) ? profile.data : null,
      priceDate: last[0],
    });
  }
  const plan = bondLadder(candidates, { ...x }, settlement);
  return {
    ...plan,
    missingTerms: missing,
    note: "ข้อเสนอการจัดพอร์ตเท่านั้น ไม่บันทึกรายการ · สภาพคล่องของหุ้นกู้ในตลาดรองอาจต่ำ ราคาจริงอาจต่างจากราคาล่าสุดที่บันทึก",
  };
}
