/** Abnormal returns: OLS vs numpy, planted α / β / AR recovered exactly, Dimson, windows, XD. Synthetic data only. */
import { describe, expect, it } from "vitest";
import golden from "./__fixtures__/numpy-ols-golden.json";
import { alignReturns, carOf, eventStudy, fitModel, ols, type ReturnSeries } from "./returns";

const dates = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, 0, 2) + i * 86_400_000).toISOString().slice(0, 10));
const series = (ri: number[], rm: number[]): ReturnSeries => ({ dates: dates(ri.length), ri, rm, skipped: { stockOnly: 0, benchmarkOnly: 0 } });
// Deterministic market returns (not market data).
const marketPath = (n: number, seed = 11) => {
  let s = seed;
  return Array.from({ length: n }, () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.03);
};

describe("OLS against numpy (np.linalg.lstsq, embedded golden values)", () => {
  const g = golden as { ri: number[]; rm: number[]; market: Record<string, number>; dimson: { alpha: number; b: number[]; beta: number; sigma: number; r2: number } };
  const x = series(g.ri, g.rm);
  it("market model", () => {
    const f = fitModel(x, "market", 0, g.ri.length - 1);
    if ("error" in f) throw new Error(f.error);
    expect(f.alpha).toBeCloseTo(g.market.alpha, 12);
    expect(f.beta).toBeCloseTo(g.market.beta, 12);
    expect(f.sigma).toBeCloseTo(g.market.sigma, 12);
    expect(f.r2!).toBeCloseTo(g.market.r2, 12);
    expect(f.n).toBe(200);
  });
  it("Dimson (lag −1, 0, +1; β = sum)", () => {
    const f = fitModel(x, "dimson", 0, g.ri.length - 1);
    if ("error" in f) throw new Error(f.error);
    expect(f.alpha).toBeCloseTo(g.dimson.alpha, 12);
    f.betas!.forEach((b, i) => expect(b).toBeCloseTo(g.dimson.b[i], 12));
    expect(f.beta).toBeCloseTo(g.dimson.beta, 12);
    expect(f.sigma).toBeCloseTo(g.dimson.sigma, 12);
    expect(f.r2!).toBeCloseTo(g.dimson.r2, 12);
    expect(f.n).toBe(198);
  });
  it("singular design → null", () => {
    expect(ols([1, 2, 3], [[1, 0], [1, 0], [1, 0]])).toBeNull();
  });
});

describe("planted α, β and abnormal returns are recovered exactly", () => {
  const n = 320;
  const rm = marketPath(n);
  const alpha = 0.0005;
  const beta = 1.2;
  const z = 280; // event day 0
  // Small residual so σ(ε) > 0, made exactly orthogonal to [1, R_m] over the estimation window
  // (k = z−250 … z−30) so OLS must return the planted α and β to machine precision.
  const est = Array.from({ length: 221 }, (_, j) => z - 250 + j);
  const raw = rm.map((_, k) => (k % 2 ? 1 : -1) * 1e-4 * (1 + (k % 7) / 7));
  const fit0 = ols(est.map((k) => raw[k]), est.map((k) => [1, rm[k]]))!;
  const eps = raw.map((v, k) => v - fit0.coef[0] - fit0.coef[1] * rm[k]);
  const planted: Record<number, number> = { [-3]: 0.01, 0: 0.05, 2: -0.02 };
  const ri = rm.map((m, k) => alpha + beta * m + (k >= z - 10 ? 0 : eps[k]) + (planted[k - z] ?? 0));
  const x = series(ri, rm);
  const r = eventStudy(x, { eventDate: x.dates[z] });
  it("fit ≈ planted parameters", () => {
    if (!r.ok) throw new Error(r.reason);
    expect(r.fit.alpha).toBeCloseTo(alpha, 12);
    expect(r.fit.beta).toBeCloseTo(beta, 12);
    expect(r.fit.sigma).toBeGreaterThan(0);
    expect(r.estimation.n).toBe(221);
    expect([r.estimation.window, r.event.window]).toEqual([[-250, -30], [-10, 10]]);
  });
  it("AR on event days equals the planted values; others ≈ 0; t = AR / σ; CAR and its t", () => {
    if (!r.ok) throw new Error(r.reason);
    for (const d of r.days) {
      expect(d.ar!).toBeCloseTo(planted[d.rel] ?? 0, 12);
      expect(d.t!).toBeCloseTo(d.ar! / r.fit.sigma, 10);
    }
    expect(r.days).toHaveLength(21);
    expect(r.days.find((d) => d.rel === 0)!.date).toBe(x.dates[z]);
    expect(r.car.value).toBeCloseTo(0.04, 12);
    expect(r.car.t!).toBeCloseTo(r.car.value / (r.fit.sigma * Math.sqrt(21)), 10);
    const c = carOf(r.days, r.fit.sigma, -1, 1);
    expect(c.value).toBeCloseTo(0.05, 12);
    expect(c.days).toBe(3);
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/);
  });
  it("market-adjusted: AR = R_i − R_m, σ from the estimation window", () => {
    const m = eventStudy(x, { eventDate: x.dates[z], model: "market_adjusted" });
    if (!m.ok) throw new Error(m.reason);
    const d0 = m.days.find((d) => d.rel === 0)!;
    expect(d0.ar).toBeCloseTo(ri[z] - rm[z], 15);
    expect(m.fit).toMatchObject({ alpha: 0, beta: 1, r2: null });
  });
  it("Dimson recovers the summed beta when the stock reacts to the market with a lag", () => {
    // Thin trading: half of the market move shows up a day late.
    const lag = rm.map((m, k) => 0.0002 + 0.6 * m + 0.6 * (rm[k - 1] ?? 0) + eps[k]);
    const xs = series(lag, rm);
    const ms = eventStudy(xs, { eventDate: xs.dates[z], model: "market" });
    const ds = eventStudy(xs, { eventDate: xs.dates[z], model: "dimson" });
    if (!ms.ok || !ds.ok) throw new Error("fit failed");
    expect(ds.fit.beta).toBeCloseTo(1.2, 2);
    expect(ms.fit.beta).toBeLessThan(0.8); // OLS beta is biased down under non-synchronous trading
    expect(ds.fit.betas![0]).toBeCloseTo(0.6, 2);
  });
});

describe("windows, missing data and XD", () => {
  const rm = marketPath(200);
  const x = series(rm.map((m) => 0.001 + m), rm);
  it("fewer than 120 estimation observations → error with the reason", () => {
    const r = eventStudy(x, { eventDate: x.dates[100] });
    expect(r).toMatchObject({ ok: false, code: "INSUFFICIENT_DATA" });
    if (!r.ok) expect(r.reason).toMatch(/ต้องมีอย่างน้อย 120/);
  });
  it("event date on a non-trading day → day 0 is the next trading day", () => {
    const gappy: ReturnSeries = { ...series(marketPath(300, 5).map((m) => m + 0.001), marketPath(300, 5)) };
    const d0 = gappy.dates[260];
    gappy.dates = gappy.dates.map((d, i) => (i >= 260 ? new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10) : d));
    const r = eventStudy(gappy, { eventDate: d0 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.day0).toBe(gappy.dates[260]);
    expect(r.eventDate).toBe(d0);
  });
  it("invalid windows and event after the data are refused", () => {
    expect(eventStudy(x, { eventDate: x.dates[150], estimation: [-10, -30] })).toMatchObject({ ok: false, code: "INVALID_WINDOW" });
    expect(eventStudy(x, { eventDate: x.dates[150], estimation: [-120, 0], event: [-5, 5] })).toMatchObject({ ok: false, code: "INVALID_WINDOW" });
    expect(eventStudy(x, { eventDate: "2099-01-01" })).toMatchObject({ ok: false, code: "EVENT_OUTSIDE_DATA" });
  });
  it("event window past the data is truncated with a warning; Dimson's last day has no expected return", () => {
    const big = series(marketPath(300).map((m) => m + 0.001), marketPath(300));
    const r = eventStudy(big, { eventDate: big.dates[295], model: "dimson" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.days.at(-1)!.rel).toBe(4);
    expect(r.days.at(-1)!.ar).toBeNull();
    expect(r.warnings.join()).toMatch(/ยังไม่มีข้อมูลหลังจากนั้น/);
  });
  it("XD inside the event window is flagged for close-vs-price-index only", () => {
    const big = series(marketPath(300).map((m) => m + 0.001), marketPath(300));
    const xd = [big.dates[270]];
    const p = eventStudy(big, { eventDate: big.dates[272], xdDates: xd, basis: "price" });
    const t = eventStudy(big, { eventDate: big.dates[272], xdDates: xd, basis: "total_return" });
    if (!p.ok || !t.ok) throw new Error("fit failed");
    expect(p.days.find((d) => d.date === xd[0])!.warnings.join()).toMatch(/XD/);
    expect(p.warnings.join()).toMatch(/XD/);
    expect(t.days.every((d) => d.warnings.length === 0)).toBe(true);
  });
});

describe("alignReturns", () => {
  it("returns only between dates both series have; counts the rest; no fill", () => {
    const s: [string, number][] = [["2026-01-02", 10], ["2026-01-05", 11], ["2026-01-06", 12], ["2026-01-07", 0]];
    const b: [string, number][] = [["2026-01-02", 100], ["2026-01-06", 110], ["2026-01-07", 120], ["2026-01-08", 130]];
    const r = alignReturns(s, b);
    expect(r.dates).toEqual(["2026-01-06"]);
    expect(r.ri[0]).toBeCloseTo(0.2, 12);
    expect(r.rm[0]).toBeCloseTo(0.1, 12);
    expect(r.skipped).toEqual({ stockOnly: 1, benchmarkOnly: 2 });
  });
});
