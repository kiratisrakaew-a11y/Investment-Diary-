/**
 * Roadmap Phase 1 — pure helpers for historical price sync: date ranges, write planning
 * (dedupe / overwrite / fill), coverage and corporate-action warnings, retry.
 */
import { describe, expect, it } from "vitest";
import { PriceSyncError, coverage, corporateActionWarnings, planWrites, resolveSyncRange, withRetry } from "./price-coverage";

describe("resolveSyncRange", () => {
  const today = "2026-10-26";
  it("defaults to 365 days back to today", () => {
    expect(resolveSyncRange({}, today)).toEqual({ from: "2025-10-26", to: "2026-10-26" });
  });
  it("uses lookbackDays or explicit dates", () => {
    expect(resolveSyncRange({ lookbackDays: 30 }, today)).toEqual({ from: "2026-09-26", to: "2026-10-26" });
    expect(resolveSyncRange({ startDate: "2024-01-01", endDate: "2024-06-30" }, today)).toEqual({ from: "2024-01-01", to: "2024-06-30" });
    expect(resolveSyncRange({ startDate: "2024-01-01" }, today)).toEqual({ from: "2024-01-01", to: today });
    expect(resolveSyncRange({ endDate: "2025-01-31", lookbackDays: 31 }, today)).toEqual({ from: "2024-12-31", to: "2025-01-31" });
  });
  it("rejects inverted, future and over-long ranges with a typed error", () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof PriceSyncError ? e.code : "other";
      }
      return "none";
    };
    expect(code(() => resolveSyncRange({ startDate: "2025-02-01", endDate: "2025-01-01" }, today))).toBe("INVALID_RANGE");
    expect(code(() => resolveSyncRange({ endDate: "2027-01-01" }, today))).toBe("INVALID_RANGE");
    expect(code(() => resolveSyncRange({ startDate: "2010-01-01" }, today))).toBe("INVALID_RANGE");
  });
});

describe("planWrites", () => {
  const existing = new Map([
    ["2026-01-02", { close: 10, adjClose: null }],
    ["2026-01-03", { close: 11, adjClose: 10.5 }],
  ]);
  const fetched = [
    { date: "2026-01-02", close: 10, adjClose: 9.6 },
    { date: "2026-01-03", close: 11.2, adjClose: 10.6 },
    { date: "2026-01-04", close: 12, adjClose: 11.4 },
  ];
  it("keeps existing values when overwrite is false and stores only new dates (close series)", () => {
    const p = planWrites(existing, fetched, { overwrite: false, priceType: "close" });
    expect(p.inserts).toEqual([{ date: "2026-01-04", close: 12, adjClose: null }]);
    expect(p.updates).toEqual([]);
    expect(p.skippedExisting).toBe(2);
    expect(p.changedButKept).toBe(1); // 2026-01-03 differs (11 vs 11.2) but is kept
  });
  it("fills a missing adjusted value without touching the stored close", () => {
    const p = planWrites(existing, fetched, { overwrite: false, priceType: "adjusted_close" });
    expect(p.inserts).toEqual([{ date: "2026-01-04", close: 12, adjClose: 11.4 }]);
    expect(p.updates).toEqual([{ date: "2026-01-02", close: 10, adjClose: 9.6 }]);
  });
  it("overwrite replaces differing values and leaves identical ones alone", () => {
    const p = planWrites(existing, fetched, { overwrite: true, priceType: "close" });
    expect(p.updates).toEqual([{ date: "2026-01-03", close: 11.2, adjClose: 10.5 }]);
    expect(p.unchanged).toBe(1);
  });
  it("is idempotent: planning again after applying gives no writes", () => {
    const after = new Map(existing);
    for (const r of planWrites(existing, fetched, { overwrite: true, priceType: "adjusted_close" }).inserts) after.set(r.date, { close: r.close, adjClose: r.adjClose });
    for (const r of planWrites(existing, fetched, { overwrite: true, priceType: "adjusted_close" }).updates) after.set(r.date, { close: r.close, adjClose: r.adjClose });
    const again = planWrites(after, fetched, { overwrite: true, priceType: "adjusted_close" });
    expect(again.inserts.length + again.updates.length).toBe(0);
  });
  it("rejects non-positive or non-finite prices instead of storing them", () => {
    const p = planWrites(new Map(), [{ date: "2026-01-05", close: 0, adjClose: null }, { date: "2026-01-06", close: NaN, adjClose: null }], { overwrite: false, priceType: "close" });
    expect(p.inserts).toEqual([]);
    expect(p.invalid).toBe(2);
  });
});

describe("coverage", () => {
  it("counts observations, largest calendar gap and staleness within the range", () => {
    const c = coverage(["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-20"], { from: "2026-01-01", to: "2026-01-31" }, "2026-01-31");
    expect(c.observations).toBe(4);
    expect(c.firstDate).toBe("2026-01-02");
    expect(c.lastDate).toBe("2026-01-20");
    expect(c.largestGapDays).toBe(14);
    expect(c.staleDays).toBe(11);
  });
  it("empty series has no dates", () => {
    expect(coverage([], { from: "2026-01-01", to: "2026-01-31" }, "2026-01-31")).toMatchObject({ observations: 0, firstDate: null, lastDate: null });
  });
});

describe("corporateActionWarnings", () => {
  it("flags splits (holdings are not adjusted) and lists dividends", () => {
    const w = corporateActionWarnings("AAA", [{ date: "2026-03-01", numerator: 2, denominator: 1 }], [{ date: "2026-04-01", amount: 0.5 }], true);
    expect(w.some((x) => x.includes("split") && x.includes("2:1"))).toBe(true);
    expect(w.some((x) => x.includes("ปันผล"))).toBe(true);
  });
  it("no events → no warnings", () => {
    expect(corporateActionWarnings("AAA", [], [], true)).toEqual([]);
  });
});

describe("withRetry", () => {
  it("retries with backoff and returns the first success", async () => {
    let n = 0;
    const waits: number[] = [];
    const r = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new Error("429 Too Many Requests");
        return "ok";
      },
      { attempts: 3, baseMs: 100, sleep: async (ms) => void waits.push(ms) },
    );
    expect(r).toBe("ok");
    expect(waits).toEqual([100, 200]);
  });
  it("gives up after the last attempt", async () => {
    await expect(withRetry(async () => Promise.reject(new Error("down")), { attempts: 2, baseMs: 1, sleep: async () => {} })).rejects.toThrow("down");
  });
});
