/**
 * Phase 5 — cross-model checks: SOTP with staged DCF / multi-stage RIM segments, and residual income
 * at 2 / 5 / 10 years against an independent closed form (all three continuing-value methods).
 */
import { describe, expect, it } from "vitest";
import { evaluate, valuationInput, type ValuationInput } from "../valuation-schemas";
import { DEFAULT_DCF, dcf, type DcfAssumptions } from "./valuation";
import { rimHorizonComparison } from "./rim-horizon";

type Sotp = Extract<ValuationInput, { method: "sotp" }>["assumptions"];
const runSotp = (a: Partial<Sotp> & Pick<Sotp, "segments">) => {
  const r = evaluate(valuationInput.parse({ method: "sotp", assumptions: { sharesOutstanding: 100, currentPrice: 10, ...a } }));
  return { r, d: r.details as { segments: { value: number | null }[]; errors: { code: string }[]; warningDetails?: { code: string }[] } };
};

const staged: DcfAssumptions = {
  ...DEFAULT_DCF,
  debt: 2_000,
  cash: 500,
  otherClaims: 100,
  sharesOutstanding: 1_000,
  targetDebtWeight: 0.3,
  forecastMode: "staged",
  years: 10,
  stages: [
    { name: "High", years: 3, revenueGrowthStart: 0.12, revenueGrowthEnd: 0.1, ebitMarginStart: 0.14, ebitMarginEnd: 0.15 },
    { name: "Transition", years: 4, revenueGrowthStart: 0.08, revenueGrowthEnd: 0.05, ebitMarginStart: 0.15, ebitMarginEnd: 0.16 },
    { name: "Mature", years: 3, revenueGrowthStart: 0.04, revenueGrowthEnd: 0.03, ebitMarginStart: 0.16, ebitMarginEnd: 0.16, capexPct: 0.04 },
  ],
};

describe("SOTP with staged DCF and multi-stage RIM segments", () => {
  it("a staged FCFF division with the group net debt equals the standalone staged DCF (debt counted once)", () => {
    const standalone = dcf(staged, "fcff");
    const { r, d } = runSotp({
      sharesOutstanding: staged.sharesOutstanding,
      netDebt: staged.debt - staged.cash + staged.otherClaims,
      segments: [{ name: "Whole", role: "division", ownership: 1, fx: 1, source: { type: "model", valuation: { method: "dcf_fcff", assumptions: staged } } }],
    });
    expect(d.segments[0].value).toBeCloseTo(standalone.enterpriseValue!, 6);
    expect(r.value).toBeCloseTo(standalone.valuePerShare!, 9);
    // The segment's own debt / cash are ignored in favour of the group bridge (no double count).
    expect((d.warningDetails ?? []).map((w) => w.code)).toContain("SEGMENT_DEBT_IGNORED");
  });

  it("a staged FCFE subsidiary on a holdco bridge equals its own equity value", () => {
    const { r } = runSotp({
      sharesOutstanding: staged.sharesOutstanding,
      netDebtBasis: "holdco",
      segments: [{ name: "Sub", role: "subsidiary", ownership: 1, fx: 1, source: { type: "model", valuation: { method: "dcf_fcfe", assumptions: staged } } }],
    });
    expect(r.value).toBeCloseTo(dcf(staged, "fcfe").valuePerShare!, 9);
  });

  it("an invalid staged segment surfaces its error and gives no value", () => {
    const { r, d } = runSotp({ segments: [{ name: "Bad", role: "division", ownership: 1, fx: 1, source: { type: "model", valuation: { method: "dcf_fcff", assumptions: { ...staged, stages: staged.stages!.slice(0, 1) } } } }] });
    expect(r.value).toBeNull();
    expect(d.errors.map((e) => e.code)).toContain("SEGMENT_MODEL");
  });

  it("a multi-stage RIM associate = value per share × segment shares × ownership", () => {
    const ri = { bookValuePerShare: 20, roe: 0.12, payoutRatio: 0.4, currentPrice: 0, riskFree: 0.03, beta: 1, equityRiskPremium: 0.07, extraPremium: 0, terminalGrowth: 0.03, forecast: [{ roe: 0.15 }, { roe: 0.14 }, { roe: 0.13 }] };
    const per = evaluate({ method: "residual_income", assumptions: { ...ri, model: "multi_stage" } }).value!;
    const { r } = runSotp({ netDebtBasis: "holdco", segments: [{ name: "Assoc", role: "associate", ownership: 0.3, fx: 1, source: { type: "model", valuation: { method: "residual_income", assumptions: ri }, shares: 50 } }] });
    expect(r.value).toBeCloseTo((per * 50 * 0.3) / 100, 9);
  });
});

/**
 * Independent closed form for constant ROE and payout (clean surplus):
 *   g = ROE(1 − p), Bₜ = B₀(1+g)ᵗ, RIₜ = (ROE − Ke)·B₀(1+g)ᵗ⁻¹,
 *   Σ PV(RI) = (ROE − Ke)B₀/(1+Ke) · (1 − qⁿ)/(1 − q), q = (1+g)/(1+Ke),
 *   RIₙ₊₁ = (ROE − Ke)·B₀(1+g)ⁿ; CV = RIₙ₊₁/(Ke − gₜ) | RIₙ₊₁/(1 + Ke − ω) | 0, PV = CV/(1+Ke)ⁿ.
 */
function closedForm(B0: number, roe: number, p: number, ke: number, n: number, t: { method: "perpetuity"; g: number } | { method: "persistence"; w: number } | { method: "none" }) {
  const g = roe * (1 - p);
  const q = (1 + g) / (1 + ke);
  const pvRi = (((roe - ke) * B0) / (1 + ke)) * ((1 - q ** n) / (1 - q));
  const riNext = (roe - ke) * B0 * (1 + g) ** n;
  const cv = t.method === "perpetuity" ? riNext / (ke - t.g) : t.method === "persistence" ? riNext / (1 + ke - t.w) : 0;
  return B0 + pvRi + cv / (1 + ke) ** n;
}

describe("RIM 2 / 5 / 10 years vs an independent closed form", () => {
  const B0 = 25;
  const roe = 0.14;
  const p = 0.45;
  const ke = 0.095;
  const forecast = Array.from({ length: 10 }, () => ({ roe }));
  const terminals = [
    { name: "perpetuity", engine: { method: "perpetuity" as const, growth: 0.03 }, ref: { method: "perpetuity" as const, g: 0.03 } },
    { name: "persistence", engine: { method: "persistence" as const, persistence: 0.7 }, ref: { method: "persistence" as const, w: 0.7 } },
    { name: "none", engine: { method: "none" as const }, ref: { method: "none" as const } },
  ];
  for (const t of terminals)
    it(`${t.name}: each horizon matches the closed form`, () => {
      const c = rimHorizonComparison({ bookValuePerShare: B0, ke, price: 30, payoutRatio: p, forecast, terminal: t.engine }, [2, 5, 10]);
      for (const row of c.rows) {
        expect(row.status).toBe("ok");
        expect(row.value).toBeCloseTo(closedForm(B0, roe, p, ke, row.horizon, t.ref), 10);
      }
    });

  it("with g = ROE × retention the perpetuity value is the same at every horizon (single-stage formula)", () => {
    const g = roe * (1 - p);
    const c = rimHorizonComparison({ bookValuePerShare: B0, ke, price: 30, payoutRatio: p, forecast, terminal: { method: "perpetuity", growth: g } }, [2, 5, 10]);
    const single = B0 + ((roe - ke) * B0) / (ke - g);
    for (const row of c.rows) expect(row.value).toBeCloseTo(single, 9);
  });

  it("hand-worked 2-year example (payout 50%, persistence ω = 0.5)", () => {
    // B0 10, ROE 20%, Ke 10%: E1 = 2, D1 = 1, B1 = 11, RI1 = 1; E2 = 2.2, B2 = 12.1, RI2 = 1.1;
    // RI3 = 0.1 × 12.1 = 1.21, CV = 1.21 / (1 + 0.1 − 0.5) = 2.01666…; V = 10 + 1/1.1 + 1.1/1.21 + CV/1.21.
    const c = rimHorizonComparison({ bookValuePerShare: 10, ke: 0.1, price: 10, payoutRatio: 0.5, forecast: [{ roe: 0.2 }, { roe: 0.2 }], terminal: { method: "persistence", persistence: 0.5 } }, [2]);
    expect(c.rows[0].value).toBeCloseTo(10 + 1 / 1.1 + 1.1 / 1.21 + 1.21 / 0.6 / 1.21, 12);
  });
});
