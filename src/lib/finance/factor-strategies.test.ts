/**
 * Strategies Phase 3 — factor signals and screening.
 */
import { describe, expect, it } from "vitest";
import { factorSignals, momentum, screenFactorStrategy, valueMetrics, type FactorInput } from "./factor-strategies";

/** Daily prints (weekdays) from `from` to `to` following f(dayIndex). */
function series(from: string, to: string, f: (i: number, d: string) => number): [string, number][] {
  const out: [string, number][] = [];
  let i = 0;
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    out.push([iso, f(i++, iso)]);
  }
  return out;
}
const asOf = "2025-12-31";
const input = (symbol: string, p: [string, number][], o: Partial<FactorInput> = {}): FactorInput => ({ symbol, issuer: symbol, sector: null, currency: "THB", prices: p, statements: [], events: [], splits: [], valuationMedian: null, ...o });

describe("momentum 12–1", () => {
  it("uses P(t−1m)/P(t−12m) − 1 and ignores the latest month", () => {
    // 100 a year ago, 120 one month ago, then a jump to 200 in the last month.
    const p = series("2024-06-01", asOf, (_, d) => (d < "2024-12-31" ? 100 : d <= "2025-11-30" ? 100 + (20 * (Date.parse(d) - Date.parse("2024-12-31"))) / (Date.parse("2025-11-30") - Date.parse("2024-12-31")) : 200));
    const m = momentum(p, asOf);
    expect(m.mom.value!).toBeCloseTo(0.2, 2);
  });
  it("insufficient without 12 months of prints (never 0)", () => {
    const m = momentum(series("2025-06-01", asOf, () => 100), asOf);
    expect(m.mom.status).toBe("insufficient");
    expect(m.mom.value).toBeNull();
  });
});

describe("value metrics", () => {
  it("earnings yield and book/price on the latest share basis after a split", () => {
    const st = [{ fiscalYear: 2024, publishedAt: "2025-02-20", eps: 10, totalEquity: 1000, sharesOutstanding: 10 }];
    const x = input("A", [], { statements: st, splits: [{ date: "2025-06-01", ratio: 2 }] });
    const v = valueMetrics(x, asOf, 50);
    expect(v.earningsYield.value).toBeCloseTo(5 / 50, 12); // EPS 10 → 5 per new share
    expect(v.bookToPrice.value).toBeCloseTo(1000 / 20 / 50, 12);
    expect(v.marginOfSafety.status).toBe("unavailable");
  });
  it("statement currency ≠ price currency → unavailable", () => {
    const v = valueMetrics(input("A", [], { statements: [{ fiscalYear: 2024, eps: 1, currency: "USD" }] }), asOf, 10);
    expect(v.earningsYield.status).toBe("unavailable");
  });
});

describe("factor screening", () => {
  const up = series("2024-06-01", asOf, (i) => 100 * 1.0012 ** i);
  const flat = series("2024-06-01", asOf, () => 100);
  const down = series("2024-06-01", asOf, (i) => 100 * 0.9992 ** i);
  const short = series("2025-09-01", asOf, () => 100);
  const st = (eps: number, roe: number) => [
    { fiscalYear: 2023, eps, netIncome: roe * 1000, totalEquity: 1000, totalDebt: 100, cash: 50, ebitda: 100, cfo: roe * 1200, capex: 10, sharesOutstanding: 100 },
    { fiscalYear: 2024, eps, netIncome: roe * 1000, totalEquity: 1000, totalDebt: 100, cash: 50, ebitda: 100, cfo: roe * 1200, capex: 10, sharesOutstanding: 100 },
    { fiscalYear: 2022, eps, netIncome: roe * 1000, totalEquity: 1000, totalDebt: 100, cash: 50, ebitda: 100, cfo: roe * 1200, capex: 10, sharesOutstanding: 100 },
  ];
  const inputs = [
    input("UP", up, { sector: "Tech", statements: st(1, 0.08) }),
    input("FLAT", flat, { sector: "Tech", statements: st(8, 0.2) }),
    input("DOWN", down, { sector: "Energy", statements: st(4, 0.12) }),
    input("NEW", short, { sector: "Energy" }),
  ];
  it("momentum ranks by 12–1 return; short history is excluded with a reason", () => {
    const r = screenFactorStrategy({ strategyId: "momentum", asOf, inputs, settings: { topN: 2 } });
    expect(r.ranked.map((x) => x.symbol)).toEqual(["UP", "FLAT", "DOWN"]);
    expect(r.excluded).toEqual([{ symbol: "NEW", code: "insufficient_data", detail: expect.stringContaining("โมเมนตัม") }]);
    expect(r.selected).toEqual(["UP", "FLAT"]);
    expect(r.factorDataCoverage.momentum).toEqual({ available: 3, total: 4 });
  });
  it("value / quality rank on fundamentals; multi-factor composite is transparent and deterministic", () => {
    const v = screenFactorStrategy({ strategyId: "value", asOf, inputs });
    const ey = (sym: string) => v.ranked.find((r) => r.symbol === sym)!.families.value.subs.find((x) => x.key === "earningsYield")!.rank;
    expect(ey("FLAT")).toBe(1); // highest earnings yield
    // FLAT (best EY) and DOWN (best book/price after its fall) tie at 0.75 → symbol order.
    expect(v.ranked.slice(0, 2).map((r) => [r.symbol, r.score])).toEqual([
      ["DOWN", 0.75],
      ["FLAT", 0.75],
    ]);
    const q = screenFactorStrategy({ strategyId: "quality", asOf, inputs });
    expect(q.ranked[0].symbol).toBe("FLAT"); // highest ROE
    const m1 = screenFactorStrategy({ strategyId: "multi_factor", asOf, inputs, settings: { familyWeights: { value: 0.5, quality: 0, momentum: 0.5, dividend: 0 } } });
    const m2 = screenFactorStrategy({ strategyId: "multi_factor", asOf, inputs: [...inputs].reverse(), settings: { familyWeights: { value: 0.5, quality: 0, momentum: 0.5, dividend: 0 } } });
    expect(m1.scores).toEqual(m2.scores);
    const flatRow = m1.ranked.find((r) => r.symbol === "FLAT")!;
    expect(flatRow.score).toBeCloseTo(0.5 * flatRow.families.value.score! + 0.5 * flatRow.families.momentum.score!, 12);
  });
  it("sector-neutral ranks within sectors", () => {
    const r = screenFactorStrategy({ strategyId: "momentum", asOf, inputs, settings: { sectorNeutral: true } });
    const fam = (s: string) => r.ranked.find((x) => x.symbol === s)!.families.momentum.score;
    expect(fam("UP")).toBe(1);
    expect(fam("FLAT")).toBe(0);
    expect(fam("DOWN")).toBe(0.5); // alone in its sector with data
  });
  it("hold buffer keeps a previous pick that slipped just outside top N", () => {
    const r = screenFactorStrategy({ strategyId: "momentum", asOf, inputs, settings: { topN: 1, holdBuffer: 1 }, previous: ["FLAT"] });
    expect(r.selected).toContain("FLAT");
    const noBuf = screenFactorStrategy({ strategyId: "momentum", asOf, inputs, settings: { topN: 1 }, previous: ["FLAT"] });
    expect(noBuf.selected).toEqual(["UP"]);
  });
  it("signals keep missing values as null", () => {
    const g = factorSignals(input("NEW", short), asOf, { volScaledMomentum: true });
    expect(g.families.momentum[0].metric.value).toBeNull();
    expect(g.families.quality.every((s) => s.metric.value == null)).toBe(true);
  });
});
