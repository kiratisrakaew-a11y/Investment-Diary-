/** Daily scan: rolling fit equals the direct OLS, planted spike / drift flagged at the right level, events, missing market data. */
import { describe, expect, it } from "vitest";
import { fitModel, type ReturnSeries } from "./returns";
import { volumeSeries } from "./volume";
import { isCalendarDate, rollingMarketFits, scanStock } from "./scan";

const N = 360;
const dates = Array.from({ length: N + 1 }, (_, i) =>
  new Date(Date.UTC(2025, 0, 2) + i * 86_400_000).toISOString().slice(0, 10),
);
const gen = (seed: number, scale: number) => {
  let s = seed;
  return Array.from(
    { length: N },
    () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * scale,
  );
};
// Synthetic (not market data): market returns, stock = 0.0003 + 1.1·R_m + noise; volume around 1e6.
const rm = gen(11, 0.03);
const noise = gen(29, 0.02);
const volNoise = gen(41, 0.6);
function build(edit?: (ri: number[], vol: number[]) => void) {
  const ri = rm.map((m, k) => 0.0003 + 1.1 * m + noise[k]);
  const vol = volNoise.map((v) => Math.round(1_000_000 * (1 + v)));
  edit?.(ri, vol);
  const x: ReturnSeries = {
    dates: dates.slice(1),
    ri,
    rm,
    skipped: { stockOnly: 0, benchmarkOnly: 0 },
  };
  // Volume series on the same trading days (return k ends on dates[k + 1]).
  const v = volumeSeries(
    dates.slice(1).map((d, k) => ({ date: d, volume: vol[k] })),
    [{ effectiveDate: dates[0], shares: 100_000_000 }],
  );
  return { x, v };
}

describe("rollingMarketFits", () => {
  it("matches the direct OLS fit on the same window (1e-10)", () => {
    const { x } = build();
    const fit = rollingMarketFits(x);
    for (const t of [250, 300, 359]) {
      const r = fit(t);
      const d = fitModel(x, "market", t - 250, t - 30);
      if ("reason" in r || "error" in d) throw new Error("fit failed");
      expect(r.alpha).toBeCloseTo(d.alpha, 10);
      expect(r.beta).toBeCloseTo(d.beta, 10);
      expect(r.sigma).toBeCloseTo(d.sigma, 10);
      expect(r.n).toBe(d.n);
    }
    expect("reason" in fit(100)).toBe(true);
  });
});

describe("scanStock", () => {
  const from = dates[300];
  it("an AR spike together with a volume spike is ผิดปกติ; ordinary days stay normal", () => {
    const t = 330;
    const { x, v } = build((ri, vol) => {
      ri[t] += 0.12;
      vol[t] *= 30;
    });
    const r = scanStock(x, v, dates.slice(1), [], { from });
    const d = r.days.find((y) => y.date === dates[t + 1])!;
    expect(d.level).toBe("ผิดปกติ");
    expect(d.tAR!).toBeGreaterThan(3);
    expect(d.z!).toBeGreaterThan(3);
    expect(d.reasons.join()).toMatch(/Volume z/);
    expect(r.flagged[0].date).toBe(d.date);
    // Without the planted spike: no ผิดปกติ day, and flags only at about the chance rate of |t| > 2 (≤ 10% of days).
    const clean = scanStock(build().x, build().v, dates.slice(1), [], { from });
    expect(clean.flagged.filter((y) => y.level === "ผิดปกติ")).toEqual([]);
    expect(clean.flagged.length).toBeLessThanOrEqual(
      Math.ceil(clean.days.length * 0.1),
    );
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/);
  });
  it("a price spike without volume is not flagged by the AR+volume rule", () => {
    const t = 330;
    const { x, v } = build((ri) => {
      ri[t] += 0.06;
    });
    const r = scanStock(x, v, dates.slice(1), [], { from });
    const d = r.days.find((y) => y.date === dates[t + 1])!;
    expect(Math.abs(d.tAR!)).toBeGreaterThan(2);
    expect(d.reasons.some((w) => /Volume z/.test(w))).toBe(false);
  });
  it("a quiet 5-day drift (accumulation) is caught by CAR5 even when no single day stands out", () => {
    const t = 340;
    const { x, v } = build((ri) => {
      for (let j = t - 4; j <= t; j++) ri[j] += 0.02;
    });
    const r = scanStock(x, v, dates.slice(1), [], { from });
    const d = r.days.find((y) => y.date === dates[t + 1])!;
    expect(d.tCAR5!).toBeGreaterThan(2);
    expect(d.level).not.toBe("ปกติ");
    expect(d.reasons.join()).toMatch(/CAR 5 วัน/);
    // Spread over 5 days, so it is not attributed to a single day.
    expect(d.warnings.join()).not.toMatch(/วันเดียว/);
  });
  it("days after a single spike: CAR5 still flags (rule unchanged) but notes it comes from that one day", () => {
    const t = 330;
    const { x, v } = build((ri, vol) => {
      ri[t] += 0.12;
      vol[t] *= 30;
    });
    const r = scanStock(x, v, dates.slice(1), [], { from });
    const after = r.days.find((y) => y.date === dates[t + 3])!;
    expect(after.level).not.toBe("ปกติ");
    expect(after.warnings.join()).toContain(`วัน ${dates[t + 1]} วันเดียว`);
    expect(
      r.days.find((y) => y.date === dates[t + 1])!.warnings.join(),
    ).not.toMatch(/วันเดียว/);
  });
  it("labels flags that come before an event within 10 trading days", () => {
    const t = 330;
    const { x, v } = build((ri, vol) => {
      ri[t] += 0.12;
      vol[t] *= 30;
    });
    const events = [
      { date: dates[t + 1 + 6], type: "news", description: "sample" },
    ];
    const r = scanStock(x, v, dates.slice(1), events, { from });
    const d = r.days.find((y) => y.date === dates[t + 1])!;
    expect(d.preEvent).toEqual({ tradingDays: 6, event: events[0] });
    const far = scanStock(
      x,
      v,
      dates.slice(1),
      [{ date: dates[t + 1 + 15], type: "news", description: "far" }],
      { from },
    );
    expect(far.days.find((y) => y.date === dates[t + 1])!.preEvent).toBeNull();
  });
  it("XD days carry a caveat with close-vs-close only", () => {
    const { x, v } = build();
    const xdDates = [dates[320]];
    const p = scanStock(x, v, dates.slice(1), [], {
      from,
      basis: "price",
      xdDates,
    });
    expect(p.days.find((y) => y.date === dates[320])!.warnings.join()).toMatch(
      /วัน XD/,
    );
    expect(p.days.find((y) => y.date === dates[322])!.warnings.join()).toMatch(
      /CAR 5 วันครอบวัน XD/,
    );
    const t = scanStock(x, v, dates.slice(1), [], {
      from,
      basis: "total_return",
      xdDates,
    });
    expect(t.days.every((y) => !y.warnings.some((w) => /XD/.test(w)))).toBe(
      true,
    );
  });
  it("thresholds are adjustable", () => {
    const t = 330;
    const { x, v } = build((ri, vol) => {
      ri[t] += 0.12;
      vol[t] *= 30;
    });
    const strict = scanStock(x, v, dates.slice(1), [], {
      from,
      thresholds: { notable: 50, abnormal: 60 },
    });
    expect(strict.flagged).toEqual([]);
  });
  it("without enough market data: no AR, never flagged on returns; high volume listed separately", () => {
    const t = 330;
    const { x, v } = build((_ri, vol) => {
      vol[t] *= 30;
    });
    const short: ReturnSeries = {
      ...x,
      dates: x.dates.slice(-60),
      ri: x.ri.slice(-60),
      rm: x.rm.slice(-60),
    };
    const r = scanStock(short, v, dates.slice(1), [], { from });
    expect(r.flagged).toEqual([]);
    expect(r.coverage.withAR).toBe(0);
    expect(r.volumeOnly.map((d) => d.date)).toContain(dates[t + 1]);
    expect(r.days.find((y) => y.date === dates[t + 1])!.missing.join()).toMatch(
      /AR: ข้อมูลตลาดพอสำหรับ/,
    );
  });
});

describe("isCalendarDate", () => {
  it("accepts real dates only", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
    for (const v of ["2026-02-30", "2026-13-40", "2026-1-01", "x"])
      expect(isCalendarDate(v)).toBe(false);
  });
});
