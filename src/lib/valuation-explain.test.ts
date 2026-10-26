import { describe, expect, it } from "vitest";
import { explainValuation, explanationToText } from "./valuation-explain";
import { evaluate, type ValuationInput } from "./valuation-schemas";
import { DEFAULT_DCF } from "./finance/valuation";

const disc = { riskFree: 0.02, beta: 1, equityRiskPremium: 0.065, extraPremium: 0 };
const inputs: ValuationInput[] = [
  { method: "dcf_fcff", assumptions: { ...DEFAULT_DCF, targetDebtWeight: 0.3 } },
  { method: "dcf_fcfe", assumptions: { ...DEFAULT_DCF, debtFinancingRatio: 0.3 } },
  { method: "ddm", assumptions: { d0: 1.2, currentPrice: 30, ...disc, model: "two_stage", highGrowth: 0.05, highGrowthYears: 5, terminalGrowth: 0.02 } },
  { method: "ddm", assumptions: { d0: 1.2, currentPrice: 30, ...disc, model: "gordon", highGrowth: 0.05, highGrowthYears: 5, terminalGrowth: 0.02 } },
  { method: "ddm", assumptions: { d0: 1.2, currentPrice: 30, ...disc, model: "h_model", highGrowth: 0.08, highGrowthYears: 6, terminalGrowth: 0.02 } },
  { method: "residual_income", assumptions: { bookValuePerShare: 20, roe: 0.12, payoutRatio: 0.5, currentPrice: 30, ...disc, terminalGrowth: 0.03 } },
  { method: "multiples", assumptions: { eps: 2, bookValuePerShare: 20, ebitda: 20000, netDebt: 20000, sharesOutstanding: 5000, currentPrice: 30, targetPE: 15, targetPBV: 1.5, targetEvEbitda: 8 } },
];

describe("valuation explanations", () => {
  it.each(inputs.map((i) => [`${i.method}${"model" in i.assumptions ? `/${i.assumptions.model}` : ""}`, i] as const))(
    "%s: explanation value matches evaluate()",
    (_n, input) => {
      const e = explainValuation(input)!;
      expect(e.value).toBeCloseTo(evaluate(input).value!, 8);
      expect(e.assumptions.length).toBeGreaterThan(3);
      expect(e.steps.length).toBeGreaterThan(2);
      expect(explanationToText(e)).toContain("ขั้นตอนการคำนวณ");
    },
  );

  it("DCF-FCFF steps reconcile: ΣPV + PV(TV) = EV and the equity bridge", () => {
    const a = { ...DEFAULT_DCF, targetDebtWeight: 0.3 };
    const e = explainValuation({ method: "dcf_fcff", assumptions: a })!;
    const get = (label: string) => e.steps.find((s) => s.label.startsWith(label))!.result!;
    const sumPv = get("มูลค่าปัจจุบันของกระแสเงินสด");
    const pvTv = get("มูลค่าปัจจุบันของ Terminal value");
    const ev = get("มูลค่ากิจการ");
    expect(sumPv + pvTv).toBeCloseTo(ev, 6);
    expect(get("มูลค่าส่วนของผู้ถือหุ้น")).toBeCloseTo(ev - a.debt + a.cash - a.otherClaims, 6);
    const pvRow = e.table!.rows.find((r) => r.label === "Present value")!;
    expect(pvRow.values.reduce((s: number, v) => s + (v ?? 0), 0)).toBeCloseTo(sumPv, 6);
  });

  it("warns when Ke − g is tiny and value is far above price", () => {
    const e = explainValuation({
      method: "residual_income",
      assumptions: { bookValuePerShare: 40, roe: 0.2, payoutRatio: 0.5, currentPrice: 30, riskFree: 0.02, beta: 1, equityRiskPremium: 0.05, extraPremium: 0, terminalGrowth: 0.06 },
    })!;
    expect(e.warnings.some((w) => w.includes("น้อยกว่า 2%"))).toBe(true);
    expect(e.warnings.some((w) => w.includes("เท่า"))).toBe(true);
  });
});
