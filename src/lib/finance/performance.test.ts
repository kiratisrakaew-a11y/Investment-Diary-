/**
 * PR 1 / Phase B regression tests — performance measurement conventions.
 * Expected values are computed independently inside each test (not by the code under test).
 */
import { describe, expect, it } from "vitest";
import { computeMetrics } from "./metrics";
import { annualizeReturn, periodReturns, xirrDetailed } from "./returns";
import { beta, expectedShortfall, historicalVaR } from "./risk";

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);

describe("B1 annualization", () => {
  it("6 months +5% is reported as cumulative, not as an annual rate", () => {
    const a = annualizeReturn(0.05, 182);
    expect(a.applicable).toBe(false);
    expect(a.annualized).toBeNull();
    expect(a.equivalent).toBeCloseTo(1.05 ** (365 / 182) - 1, 10);
  });

  it("metrics: short period exposes cumulative + labelled equivalent, ≥ 1 year annualizes", () => {
    const m = computeMetrics({
      values: [
        { date: "2024-01-01", value: 100, flow: 100 },
        { date: "2024-07-01", value: 105, flow: 0 },
      ],
      cashFlows: [{ date: "2024-01-01", amount: -100 }],
      finalValue: 105,
      finalDate: "2024-07-01",
      riskFreeRate: 0.02,
    });
    expect(m.cumulativeReturn).toBeCloseTo(0.05);
    expect(m.annualizationApplicable).toBe(false);
    expect(m.annualizedReturn).toBeNull();
    expect(m.periodDays).toBe(182);
    expect(m.displayReturnConvention).toBe("cumulative");
  });
});

describe("B1 periodic Sharpe / volatility (no fixed √252)", () => {
  // 40 weekly observations with alternating returns.
  const start = "2024-01-01";
  const rets = Array.from({ length: 40 }, (_, i) => (i % 2 ? -0.01 : 0.02));
  const values = [{ date: start, value: 100, flow: 100 }];
  for (let i = 0; i < rets.length; i++) values.push({ date: addDays(start, 7 * (i + 1)), value: values[i].value * (1 + rets[i]), flow: 0 });
  const rf = 0.03;
  const m = computeMetrics({ values, cashFlows: [], finalValue: values.at(-1)!.value, finalDate: values.at(-1)!.date, riskFreeRate: rf });

  // Independent reference.
  const rfW = (1 + rf) ** (7 / 365) - 1;
  const ex = rets.map((r) => r - rfW);
  const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
  const sd = (x: number[]) => Math.sqrt(x.reduce((a, b) => a + (b - mean(x)) ** 2, 0) / (x.length - 1));
  const N = 40 / ((40 * 7) / 365);

  it("observations per year come from the data (weekly ≈ 52.14)", () => {
    expect(m.observationsPerYear).toBeCloseTo(N, 6);
  });
  it("volatility = σ(periodic) × √N", () => {
    expect(m.volatility!).toBeCloseTo(sd(rets) * Math.sqrt(N), 10);
  });
  it("Sharpe = mean(excess) / σ(excess) × √N", () => {
    expect(m.sharpe!).toBeCloseTo((mean(ex) / sd(ex)) * Math.sqrt(N), 10);
  });
  it("arithmetic and geometric annual returns are reported separately", () => {
    expect(m.arithmeticAnnualReturn!).toBeCloseTo(mean(rets) * N, 10);
    expect(m.annualizedEquivalent!).not.toBeCloseTo(m.arithmeticAnnualReturn!, 4);
  });
});

describe("B2 TWR cash-flow timing", () => {
  const pts = [
    { date: "2024-01-01", value: 100, flow: 100 },
    { date: "2024-01-02", value: 210, flow: 100 },
  ];
  it("start-of-day: V1/(V0+CF) − 1", () => expect(periodReturns(pts, "start_of_day").returns[0].r).toBeCloseTo(210 / 200 - 1));
  it("end-of-day: (V1 − CF)/V0 − 1", () => expect(periodReturns(pts, "end_of_day").returns[0].r).toBeCloseTo(110 / 100 - 1));
  it("Modified Dietz (mid-day weight 0.5)", () => expect(periodReturns(pts, "modified_dietz").returns[0].r).toBeCloseTo((210 - 100 - 100) / (100 + 50)));
  it("withdrawal to zero and zero bases are skipped with an issue, not divided by zero", () => {
    const r = periodReturns(
      [
        { date: "2024-01-01", value: 100, flow: 100 },
        { date: "2024-01-02", value: 0, flow: -100 },
        { date: "2024-01-03", value: 50, flow: 50 },
      ],
      "end_of_day",
    );
    expect(r.returns.every((x) => Number.isFinite(x.r))).toBe(true);
    expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("B3 XIRR", () => {
  it("matches the Excel documentation example", () => {
    const r = xirrDetailed([
      { date: "2008-01-01", amount: -10000 },
      { date: "2008-03-01", amount: 2750 },
      { date: "2008-10-30", amount: 4250 },
      { date: "2009-02-15", amount: 3250 },
      { date: "2009-04-01", amount: 2750 },
    ]);
    expect(r.status).toBe("ok");
    expect(r.rate!).toBeCloseTo(0.373362535, 6);
    expect(Math.abs(r.residual!)).toBeLessThan(1e-6);
  });
  it("no sign change → null with status", () => {
    const r = xirrDetailed([
      { date: "2024-01-01", amount: -100 },
      { date: "2024-06-01", amount: -50 },
    ]);
    expect(r.rate).toBeNull();
    expect(r.status).toBe("no_sign_change");
  });
  it("multiple roots are flagged, not reported as a unique rate", () => {
    // −100, +230, −132 one and two years apart: NPV = 0 at r = 10% and r = 20%.
    const r = xirrDetailed([
      { date: "2023-01-01", amount: -100 },
      { date: "2024-01-01", amount: 230 },
      { date: "2024-12-31", amount: -132 },
    ]);
    expect(r.status).toBe("multiple_roots");
    expect(r.rate).toBeNull();
    expect(r.candidates.length).toBe(2);
    expect(r.candidates[0]).toBeCloseTo(0.1, 3);
    expect(r.candidates[1]).toBeCloseTo(0.2, 3);
  });
});

describe("B4 benchmark alignment, beta, IR", () => {
  it("benchmark holidays do not create zero returns; pairs only actual prints", () => {
    const start = "2024-01-01";
    const values = [{ date: start, value: 100, flow: 100 }];
    const bench: [string, number][] = [[start, 1000]];
    for (let i = 1; i <= 60; i++) {
      const d = addDays(start, i);
      const rb = Math.sin(i) / 100;
      values.push({ date: d, value: values[i - 1].value * (1 + 2 * rb), flow: 0 });
      if (i % 10 !== 0) bench.push([d, bench[bench.length - 1][1] * (1 + rb)]); // every 10th day the index is closed
    }
    const m = computeMetrics({
      values,
      cashFlows: [],
      finalValue: values.at(-1)!.value,
      finalDate: values.at(-1)!.date,
      riskFreeRate: 0,
      benchmark: { symbol: "IDX", series: bench, kind: "price_index" },
    });
    // 61 dates, 6 holidays (days 10, 20 … 60) → 55 prints → 54 paired intervals, none spanning a filled-in zero.
    expect(bench.length).toBe(55);
    expect(m.benchmark!.observations).toBe(bench.length - 1);
    expect(m.benchmark!.kind).toBe("price_index");
    expect(m.benchmark!.regressionBeta).not.toBeNull();
  });

  it("zero-variance benchmark → beta unavailable (null), not 0", () => {
    expect(beta([0.01, -0.02, 0.03, 0.01], [0, 0, 0, 0])).toBeNull();
  });

  it("IR = annualized mean active return / annualized tracking error; regression alpha with SE", () => {
    const start = "2024-01-01";
    const values = [{ date: start, value: 100, flow: 100 }];
    const bench: [string, number][] = [[start, 100]];
    const rb: number[] = [];
    const rp: number[] = [];
    for (let i = 1; i <= 120; i++) {
      const b = Math.sin(i * 1.3) / 100;
      const p = 0.0005 + 1.2 * b + Math.cos(i * 0.7) / 1000;
      rb.push(b);
      rp.push(p);
      values.push({ date: addDays(start, i), value: values[i - 1].value * (1 + p), flow: 0 });
      bench.push([addDays(start, i), bench[i - 1][1] * (1 + b)]);
    }
    const m = computeMetrics({ values, cashFlows: [], finalValue: values.at(-1)!.value, finalDate: values.at(-1)!.date, riskFreeRate: 0, benchmark: { symbol: "IDX", series: bench, kind: "price_index" } });
    const mean = (x: number[]) => x.reduce((a, c) => a + c, 0) / x.length;
    const sd = (x: number[]) => Math.sqrt(x.reduce((a, c) => a + (c - mean(x)) ** 2, 0) / (x.length - 1));
    const active = rp.map((p, i) => p - rb[i]);
    const N = 120 / (120 / 365);
    expect(m.benchmark!.informationRatio!).toBeCloseTo((mean(active) * N) / (sd(active) * Math.sqrt(N)), 8);
    const bx = mean(rb);
    const by = mean(rp);
    const sxx = rb.reduce((a, x) => a + (x - bx) ** 2, 0);
    const bHat = rb.reduce((a, x, i) => a + (x - bx) * (rp[i] - by), 0) / sxx;
    expect(m.benchmark!.regressionBeta!).toBeCloseTo(bHat, 10);
    expect(m.benchmark!.regressionAlphaAnnual!).toBeCloseTo((by - bHat * bx) * N, 8);
    expect(m.benchmark!.alphaStdError!).toBeGreaterThan(0);
  });
});

describe("B5 risk sample adequacy", () => {
  it("VaR/ES unavailable on small samples", () => {
    const rs = Array.from({ length: 50 }, (_, i) => (i - 25) / 1000);
    expect(historicalVaR(rs, 0.95)).toBeNull();
    expect(expectedShortfall(rs, 0.95)).toBeNull();
  });
  it("Expected shortfall averages the tail mass n(1−c)", () => {
    const rs = Array.from({ length: 200 }, (_, i) => (i - 100) / 1000); // −0.100 … +0.099
    // Worst 10 observations: −0.100 … −0.091 → mean −0.0955
    expect(expectedShortfall(rs, 0.95)!).toBeCloseTo(0.0955, 10);
  });
  it("ratios are withheld when there are too few observations", () => {
    const m = computeMetrics({
      values: [
        { date: "2024-01-01", value: 100, flow: 100 },
        { date: "2024-01-02", value: 101, flow: 0 },
        { date: "2024-01-03", value: 102, flow: 0 },
      ],
      cashFlows: [],
      finalValue: 102,
      finalDate: "2024-01-03",
      riskFreeRate: 0.02,
    });
    expect(m.sharpe).toBeNull();
    expect(m.dataQuality.status).toBe("insufficient");
  });
});
