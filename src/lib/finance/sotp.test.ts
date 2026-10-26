/**
 * Roadmap Phase 2 — SOTP bridge, double-counting controls and reuse of the existing models.
 */
import { describe, expect, it } from "vitest";
import { evaluate, valuationInput, type ValuationInput } from "../valuation-schemas";
import { DEFAULT_DCF, dcf, costOfEquity, twoStageDdm } from "./valuation";

type Sotp = Extract<ValuationInput, { method: "sotp" }>["assumptions"];
type Seg = Sotp["segments"][number];

const manual = (value: number, basis: "enterprise" | "equity" = "equity") => ({ type: "manual" as const, value, basis, source: "test report 2026" });
const seg = (s: Partial<Seg> & Pick<Seg, "name" | "role" | "source">): Seg => ({ ownership: 1, fx: 1, ...s });
const run = (a: Partial<Sotp> & Pick<Sotp, "segments">) => {
  const input = valuationInput.parse({ method: "sotp", assumptions: { sharesOutstanding: 100, currentPrice: 10, ...a } });
  const r = evaluate(input);
  const d = r.details as unknown as Omit<import("./sotp").SotpResult, "warnings"> & { warnings: import("./sotp").SotpIssue[] };
  return { r, d: { ...d, warnings: r.details.warningDetails as import("./sotp").SotpIssue[] } };
};
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

describe("SOTP bridge", () => {
  it("division EV + partly owned subsidiary at equity + associate, holdco discount on investments only", () => {
    const { r, d } = run({
      netDebt: 700,
      nonOperatingAssets: [{ name: "Land bank", value: 50 }],
      holdingDiscount: 0.1,
      holdingDiscountBase: "investments_only",
      segments: [
        seg({ name: "Core", role: "division", source: manual(1000, "enterprise") }),
        seg({ name: "SubCo", role: "subsidiary", ownership: 0.6, source: { type: "market", price: 5, shares: 100 }, netDebt: 200 }),
        seg({ name: "AssocCo", role: "associate", ownership: 0.3, source: manual(400) }),
      ],
    });
    // gross 1000 + 0.6×500 + 0.3×400 = 1420; discount 10% × 420 = 42;
    // net debt 700 − 200 (SubCo's, already deducted inside its equity value) = 500
    // equity = 1420 − 42 + 50 − 500 = 928
    expect(d.errors).toEqual([]);
    expect(d.reconciliation!.sumOfParts).toBeCloseTo(1420);
    expect(d.reconciliation!.holdingDiscount).toBeCloseTo(42);
    expect(d.reconciliation!.netDebtCountedInSegments).toBeCloseTo(200);
    expect(d.reconciliation!.netDebtDeducted).toBeCloseTo(500);
    expect(r.value).toBeCloseTo(9.28);
    expect(r.upside).toBeCloseTo(-0.072);
    expect(d.reconciliation!.difference).toBeCloseTo(0);
    expect(d.waterfall.at(-1)!.amount).toBeCloseTo(928);
    expect(d.segments.find((s) => s.name === "Core")!.debtAt).toBe("parent");
  });

  it("derives minority interest for a partly owned subsidiary counted at 100% EV", () => {
    const { r, d } = run({
      netDebt: 300,
      segments: [seg({ name: "SubCo", role: "subsidiary", ownership: 0.6, source: manual(500, "enterprise"), netDebt: 100 })],
    });
    // 500 − 300 − 0.4 × (500 − 100) = 40
    expect(d.reconciliation!.minoritySource).toBe("derived");
    expect(d.reconciliation!.minorityInterest).toBeCloseTo(160);
    expect(r.value).toBeCloseTo(0.4);
    expect(codes(d.warnings)).toContain("MINORITY_DERIVED");
  });

  it("errors when minorities cannot be reconciled", () => {
    const sub = seg({ name: "SubCo", role: "subsidiary", ownership: 0.6, source: manual(500, "enterprise") });
    expect(codes(run({ netDebt: 300, segments: [sub] }).d.errors)).toContain("MISSING_MINORITY");
    expect(codes(run({ netDebt: 300, minorityInterest: 0, segments: [{ ...sub, netDebt: 100 }] }).d.errors)).toContain("MISSING_MINORITY");
    const given = run({ netDebt: 300, minorityInterest: 150, segments: [sub] });
    expect(given.d.errors).toEqual([]);
    expect(given.r.value).toBeCloseTo(0.5);
  });

  it("warns when minorities are deducted for a subsidiary already counted at its ownership share", () => {
    const { d } = run({ minorityInterest: 80, segments: [seg({ name: "SubCo", role: "subsidiary", ownership: 0.6, source: manual(500), netDebt: 0 })] });
    expect(codes(d.warnings)).toContain("MINORITY_DOUBLE_COUNT");
  });

  it("debt double counting: a consolidated equity value without its net debt cannot be bridged against consolidated net debt", () => {
    const segments = [seg({ name: "SubCo", role: "subsidiary", source: manual(500) })];
    const bad = run({ netDebt: 300, segments });
    expect(bad.r.value).toBeNull();
    expect(codes(bad.d.errors)).toContain("DEBT_DOUBLE_COUNT");
    // With a holdco net debt figure the subsidiary's debt is not in the parent number → fine.
    const ok = run({ netDebt: 100, netDebtBasis: "holdco", segments });
    expect(ok.r.value).toBeCloseTo(4);
  });

  it("an EV of a non-consolidated or holdco-bridged segment must carry its own debt", () => {
    expect(codes(run({ segments: [seg({ name: "A", role: "associate", ownership: 0.3, source: manual(500, "enterprise") })] }).d.errors)).toContain("MISSING_SEGMENT_DEBT");
    expect(codes(run({ segments: [seg({ name: "A", role: "associate", ownership: 0.3, source: manual(500, "enterprise"), debtAt: "parent" })] }).d.errors)).toContain("EV_NEEDS_OWN_DEBT");
    expect(codes(run({ netDebtBasis: "holdco", segments: [seg({ name: "D", role: "division", source: manual(500, "enterprise"), debtAt: "parent" })] }).d.errors)).toContain("DEBT_OMITTED");
    const assoc = run({ segments: [seg({ name: "A", role: "associate", ownership: 0.3, source: manual(500, "enterprise"), netDebt: 100 })] });
    expect(assoc.r.value).toBeCloseTo(1.2); // 0.3 × (500 − 100) / 100
  });

  it("investment and entity duplication, cash counted twice, invalid ownership", () => {
    const dup = run({
      segments: [seg({ name: "Listed stake", entity: "XYZ", role: "investment", ownership: 0.1, source: { type: "market", price: 10, shares: 100 } })],
      nonOperatingAssets: [{ name: "Investment in XYZ", entity: "xyz", value: 100 }, { name: "Cash", value: 20 }],
    });
    expect(codes(dup.d.errors)).toContain("INVESTMENT_DOUBLE_COUNT");
    expect(codes(dup.d.warnings)).toContain("CASH_DOUBLE_COUNT");
    const twice = run({ segments: [seg({ name: "A", role: "associate", source: manual(1), ownership: 0.2 }), seg({ name: "a ", role: "associate", source: manual(1), ownership: 0.2 })] });
    expect(codes(twice.d.errors)).toContain("DUPLICATE_ENTITY");
    expect(codes(run({ segments: [seg({ name: "D", role: "division", ownership: 0.5, source: manual(1) })] }).d.errors)).toContain("DIVISION_OWNERSHIP");
    expect(() => run({ segments: [seg({ name: "X", role: "investment", ownership: 1.2, source: manual(1) })] })).toThrow();
  });

  it("converts segment currencies with fx and deducts eliminations and other claims", () => {
    const { r, d } = run({
      netDebtBasis: "holdco",
      otherClaims: [{ name: "Preferred", value: 30 }],
      eliminations: [{ name: "Intra-group rent", value: 20 }],
      segments: [seg({ name: "US Co", role: "investment", ownership: 0.5, fx: 35, source: { type: "market", price: 2, shares: 10 } })],
    });
    // 0.5 × 20 × 35 = 350 − 30 − 20 = 300
    expect(r.value).toBeCloseTo(3);
    expect(d.segments[0].value).toBeCloseTo(700);
  });

  it("requires a source for manual values", () => {
    expect(() => valuationInput.parse({ method: "sotp", assumptions: { sharesOutstanding: 1, currentPrice: 1, segments: [{ name: "X", role: "investment", source: { type: "manual", value: 1, source: "" } }] } })).toThrow();
  });

  it("sensitivity: segment ±10% and holding discount grid", () => {
    const { d } = run({ netDebtBasis: "holdco", holdingDiscount: 0.2, segments: [seg({ name: "A", role: "investment", source: manual(1000) })] });
    const s = d.sensitivity!;
    expect(s.segments[0].down).toBeCloseTo(7.2); // 900 × 0.8 / 100
    expect(s.segments[0].up).toBeCloseTo(8.8);
    expect(s.holdingDiscount.find((x) => x.discount === 0)!.value).toBeCloseTo(10);
  });
});

describe("SOTP reuses the existing models", () => {
  const a = { ...DEFAULT_DCF, debt: 2_000, cash: 500, otherClaims: 100, sharesOutstanding: 1_000, targetDebtWeight: 0.3 };

  it("one division valued by DCF-FCFF with the group net debt = the standalone DCF value per share", () => {
    const standalone = dcf(a, "fcff");
    const { r, d } = run({
      sharesOutstanding: a.sharesOutstanding,
      netDebt: a.debt - a.cash + a.otherClaims,
      segments: [seg({ name: "Whole company", role: "division", source: { type: "model", valuation: { method: "dcf_fcff", assumptions: a } } })],
    });
    expect(d.segments[0].value).toBeCloseTo(standalone.enterpriseValue!);
    expect(r.value).toBeCloseTo(standalone.valuePerShare!);
    expect(codes(d.warnings)).toContain("SEGMENT_DEBT_IGNORED");
  });

  it("same value when the DCF segment deducts its own debt and the parent has no other debt", () => {
    const { r } = run({
      sharesOutstanding: a.sharesOutstanding,
      netDebtBasis: "holdco",
      segments: [seg({ name: "Whole company", role: "subsidiary", source: { type: "model", valuation: { method: "dcf_fcff", assumptions: a } } })],
    });
    expect(r.value).toBeCloseTo(dcf(a, "fcff").valuePerShare!);
  });

  it("DDM segment = per-share value × segment shares × ownership; a missing share count is an error", () => {
    const ddm = { d0: 1, currentPrice: 0, riskFree: 0.03, beta: 1, equityRiskPremium: 0.06, extraPremium: 0, model: "two_stage" as const, highGrowth: 0.05, highGrowthYears: 5, terminalGrowth: 0.02 };
    const per = twoStageDdm(1, costOfEquity(0.03, 1, 0.06, 0), 0.05, 5, 0.02).value;
    const { r } = run({ netDebtBasis: "holdco", segments: [seg({ name: "Bank", role: "associate", ownership: 0.25, source: { type: "model", valuation: { method: "ddm", assumptions: ddm }, shares: 200 } })] });
    expect(r.value).toBeCloseTo((per * 200 * 0.25) / 100);
    const missing = run({ netDebtBasis: "holdco", segments: [seg({ name: "Bank", role: "associate", ownership: 0.25, source: { type: "model", valuation: { method: "ddm", assumptions: ddm } } })] });
    expect(missing.r.value).toBeNull();
    expect(missing.d.errors.some((e) => e.message.includes("shares"))).toBe(true);
  });

  it("a failing sub-model surfaces its error and gives no value", () => {
    const bad = { ...a, terminalGrowth: 0.5 };
    const { r, d } = run({ segments: [seg({ name: "X", role: "division", source: { type: "model", valuation: { method: "dcf_fcff", assumptions: bad } } })] });
    expect(r.value).toBeNull();
    expect(codes(d.errors)).toContain("SEGMENT_MODEL");
  });

  it("round-trips through JSON (save / reload) with the same result", () => {
    const input = valuationInput.parse({
      method: "sotp",
      assumptions: { sharesOutstanding: 100, currentPrice: 10, netDebt: 50, segments: [{ name: "Core", role: "division", source: { type: "multiple", metric: 100, multiple: 8 } }] },
    });
    const again = valuationInput.parse(JSON.parse(JSON.stringify(input)));
    expect(evaluate(again).value).toBeCloseTo(evaluate(input).value!);
    expect(evaluate(input).value).toBeCloseTo(7.5);
  });
});
