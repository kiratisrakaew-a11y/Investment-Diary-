/**
 * Roadmap Phase 3 — Black–Litterman numerical tests.
 */
import { describe, expect, it } from "vitest";
import { blackLitterman, type BlInput } from "./black-litterman";
import { invert } from "./optimizer";
import { recommend } from "./recommend";

const symbols = ["A", "B", "C"];
const cov = [
  [0.04, 0.012, 0.006],
  [0.012, 0.09, 0.018],
  [0.006, 0.018, 0.0225],
];
const base: BlInput = { symbols, cov, rf: 0.02, marketWeights: { A: 0.5, B: 0.3, C: 0.2 }, riskAversion: 2.5, tau: 0.05, views: [] };

const mm = (a: number[][], b: number[][]) => a.map((r) => b[0].map((_, j) => r.reduce((s, x, k) => s + x * b[k][j], 0)));
const mv = (a: number[][], v: number[]) => a.map((r) => r.reduce((s, x, k) => s + x * v[k], 0));
const tr = (a: number[][]) => a[0].map((_, j) => a.map((r) => r[j]));

describe("Black–Litterman", () => {
  it("prior Π = δΣw (+Rf); reverse optimization recovers the market weights", () => {
    const r = blackLitterman(base);
    const w = [0.5, 0.3, 0.2];
    const pi = mv(cov, w).map((x) => 2.5 * x);
    r.prior.forEach((p, i) => expect(p).toBeCloseTo(pi[i] + 0.02, 12));
    expect(r.posterior).toEqual(r.prior);
    const back = mv(invert(cov)!, pi).map((x) => x / 2.5);
    back.forEach((x, i) => expect(x).toBeCloseTo(w[i], 10));
  });

  it("matches the Theil mixed-estimation form [(τΣ)⁻¹ + PᵀΩ⁻¹P]⁻¹[(τΣ)⁻¹Π + PᵀΩ⁻¹Q] and its posterior covariance", () => {
    const r = blackLitterman({
      ...base,
      views: [
        { type: "absolute", symbol: "A", return: 0.1, confidence: 0.6 },
        { type: "relative", long: ["B"], short: ["C"], return: 0.03, confidence: 0.4 },
      ],
    });
    expect(r.ok).toBe(true);
    const P = r.views.map((v) => v.p);
    const Q = [0.1 - 0.02, 0.03];
    const omegaInv = r.views.map((v, i) => r.views.map((_, j) => (i === j ? 1 / v.omega : 0)));
    const tS = cov.map((row) => row.map((x) => x * 0.05));
    const tSi = invert(tS)!;
    const pi = r.prior.map((p) => p - 0.02);
    const H = invert(tSi.map((row, i) => row.map((x, j) => x + mm(mm(tr(P), omegaInv), P)[i][j])))!;
    const rhs = mv(tSi, pi).map((x, i) => x + mv(mm(tr(P), omegaInv), Q)[i]);
    const theil = mv(H, rhs);
    r.posterior.forEach((p, i) => expect(p - 0.02).toBeCloseTo(theil[i], 10));
    r.posteriorCov!.forEach((row, i) => row.forEach((x, j) => expect(x).toBeCloseTo(cov[i][j] + H[i][j], 10)));
  });

  it("confidence: 50% → He–Litterman ω = pτΣpᵀ (one asset: posterior is the average of Π and Q); 100% → the view holds exactly", () => {
    const one: BlInput = { symbols: ["X"], cov: [[0.04]], rf: 0, marketWeights: { X: 1 }, riskAversion: 2.5, tau: 0.05, views: [] };
    const half = blackLitterman({ ...one, views: [{ type: "absolute", symbol: "X", return: 0.2, confidence: 0.5 }] });
    expect(half.views[0].omega).toBeCloseTo(0.05 * 0.04, 12);
    expect(half.posterior[0]).toBeCloseTo((0.1 + 0.2) / 2, 12); // Π = 2.5 × 0.04 = 0.10
    const full = blackLitterman({ ...base, views: [{ type: "relative", long: ["A"], short: ["B", "C"], return: 0.01, confidence: 1 }] });
    expect(full.views[0].posteriorValue).toBeCloseTo(0.01, 12);
    const faint = blackLitterman({ ...base, views: [{ type: "absolute", symbol: "A", return: 0.5, confidence: 1e-9 }] });
    faint.posterior.forEach((p, i) => expect(p).toBeCloseTo(faint.prior[i], 6));
  });

  it("an explicit view variance overrides the confidence-based Ω", () => {
    const r = blackLitterman({ ...base, views: [{ type: "absolute", symbol: "C", return: 0.08, confidence: 0.5, variance: 0.0004 }] });
    expect(r.views[0].omega).toBe(0.0004);
  });

  it("views on uncorrelated assets leave the others unchanged; relative views are unaffected by Rf", () => {
    const diag = [[0.04, 0, 0], [0, 0.09, 0], [0, 0, 0.0225]];
    const r = blackLitterman({ ...base, cov: diag, views: [{ type: "absolute", symbol: "A", return: 0.15, confidence: 0.7 }] });
    expect(r.posterior[1]).toBeCloseTo(r.prior[1], 12);
    expect(r.posterior[0]).toBeGreaterThan(r.prior[0]);
    const rel = (rf: number) => blackLitterman({ ...base, rf, views: [{ type: "relative", long: ["A"], short: ["C"], return: 0.04, confidence: 0.5 }] });
    expect(rel(0.0).posterior[0] - rel(0.0).posterior[2]).toBeCloseTo(rel(0.05).posterior[0] - rel(0.05).posterior[2], 12);
  });

  it("δ implied from ERP when not given: δ = ERP / wᵀΣw", () => {
    const r = blackLitterman({ ...base, riskAversion: undefined, marketPremium: 0.06 });
    const w = [0.5, 0.3, 0.2];
    const v = w.reduce((s, wi, i) => s + wi * mv(cov, w)[i], 0);
    expect(r.riskAversion).toBeCloseTo(0.06 / v, 12);
    expect(r.riskAversionSource).toBe("implied");
    // Market premium recovered: wᵀΠ = ERP
    expect(w.reduce((s, wi, i) => s + wi * (r.prior[i] - 0.02), 0)).toBeCloseTo(0.06, 12);
  });

  it("validation: market weights are required for every asset (never defaulted to holdings), bad views are rejected", () => {
    expect(blackLitterman({ ...base, marketWeights: { A: 1 } }).errors[0]).toContain("B, C");
    expect(blackLitterman({ ...base, views: [{ type: "absolute", symbol: "Z", return: 0.1, confidence: 0.5 }] }).ok).toBe(false);
    expect(blackLitterman({ ...base, views: [{ type: "relative", long: ["A"], short: ["A"], return: 0.1, confidence: 0.5 }] }).ok).toBe(false);
    expect(blackLitterman({ ...base, views: [{ type: "absolute", symbol: "A", return: 0.1, confidence: 0 }] }).ok).toBe(false);
    const twice = blackLitterman({
      ...base,
      views: [
        { type: "absolute", symbol: "A", return: 0.1, confidence: 1 },
        { type: "absolute", symbol: "A", return: 0.12, confidence: 1 },
      ],
    });
    expect(twice.ok).toBe(false);
    const norm = blackLitterman({ ...base, marketWeights: { A: 50, B: 30, C: 20 } });
    expect(norm.marketWeights[0]).toBeCloseTo(0.5);
    expect(norm.warnings.some((w) => w.includes("100%"))).toBe(true);
  });

  it("feeds the existing optimizer: without views the unconstrained-style recommendation is close to the market weights", () => {
    const r = blackLitterman(base);
    const rec = recommend({ symbols, mu: r.prior, cov, rf: 0.02, bounds: { min: 0, max: 1 }, objective: "max_sharpe", riskAversion: 4, useRiskFree: false });
    expect(rec.ok).toBe(true);
    if (rec.ok) rec.risky.weights.forEach((x, i) => expect(x).toBeCloseTo([0.5, 0.3, 0.2][i], 4));
  });
});
