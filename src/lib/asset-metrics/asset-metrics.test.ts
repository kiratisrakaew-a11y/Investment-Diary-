/** Asset custom metrics: threshold semantics, effective dating and scale-safe series (pure). */
import { describe, expect, it } from "vitest";
import { evaluateThreshold, freshness, ruleForDate, statusOn, validateRule, versionConflicts, type ThresholdVersion } from "./thresholds";
import { actualLayout, baseDateWarning, clean, indexSeries, latestChange, pctChangeSeries, thresholdSegments, unionRows, windowStart } from "./series";
import { decimal, metricKey, thresholdInput } from "./schemas";

const lower = { ruleType: "lower_is_better" as const, greenBound: "2.5", yellowBound: "3.5" };
const higher = { ruleType: "higher_is_better" as const, yellowBound: 150, greenBound: 180 };
const range = { ruleType: "target_range" as const, yellowMin: -1, greenMin: 0, greenMax: 2, yellowMax: 3 };

describe("threshold boundaries (spec test 4)", () => {
  it("lower_is_better: 2.5 GREEN, 3.1 YELLOW, 3.5 YELLOW, 3.6 RED", () => {
    expect([2.5, 3.1, 3.5, 3.6].map((v) => evaluateThreshold(v, lower).status)).toEqual(["GREEN", "YELLOW", "YELLOW", "RED"]);
    expect(evaluateThreshold("2.50", lower).status).toBe("GREEN"); // decimal strings from numeric columns
  });
  it("higher_is_better: 149.99 RED, 150 YELLOW, 179.9 YELLOW, 180 GREEN", () => {
    expect([149.99, 150, 179.9, 180].map((v) => evaluateThreshold(v, higher).status)).toEqual(["RED", "YELLOW", "YELLOW", "GREEN"]);
  });
  it("target_range incl. negatives and zero", () => {
    expect([-1.01, -1, -0.5, 0, 1, 2, 2.5, 3, 3.01].map((v) => evaluateThreshold(v, range).status)).toEqual(["RED", "YELLOW", "YELLOW", "GREEN", "GREEN", "GREEN", "YELLOW", "YELLOW", "RED"]);
  });
  it("invalid rules are rejected; missing value is NO_DATA; missing rule NO_THRESHOLD (spec test 5)", () => {
    expect(validateRule({ ruleType: "lower_is_better", greenBound: 3, yellowBound: 3 })).not.toEqual([]);
    expect(validateRule({ ruleType: "higher_is_better", greenBound: 1, yellowBound: 2 })).not.toEqual([]);
    expect(validateRule({ ruleType: "target_range", yellowMin: 0, greenMin: 0, greenMax: 1, yellowMax: 2 })).not.toEqual([]);
    expect(evaluateThreshold(null, lower).status).toBe("NO_DATA");
    expect(evaluateThreshold("abc", lower).status).toBe("NO_DATA");
    expect(evaluateThreshold(Infinity, lower).status).toBe("NO_DATA");
    expect(evaluateThreshold(3, null).status).toBe("NO_THRESHOLD");
    expect(() => thresholdInput.parse({ ruleType: "lower_is_better", effectiveFrom: "2026-01-01", greenBound: 4, yellowBound: 3 })).toThrow();
  });
});

describe("effective-dated versions (spec test 6)", () => {
  const A: ThresholdVersion = { id: 1, ...lower, effectiveFrom: "2024-01-01", effectiveTo: "2025-07-01" };
  const B: ThresholdVersion = { id: 2, ruleType: "lower_is_better", greenBound: 2, yellowBound: 3, effectiveFrom: "2025-07-01", effectiveTo: null };
  it("old observations use the rule in effect on their date; before any rule → NO_THRESHOLD", () => {
    expect(statusOn([A, B], "2025-06-30", 2.8)).toMatchObject({ status: "YELLOW", versionId: 1 });
    expect(statusOn([A, B], "2025-07-01", 2.8)).toMatchObject({ status: "YELLOW", versionId: 2 });
    expect(statusOn([A, B], "2025-07-01", 2.4)).toMatchObject({ status: "YELLOW", versionId: 2 }); // 2.4 > 2 under B
    expect(statusOn([A, B], "2024-12-31", 2.4).status).toBe("GREEN"); // A: 2.4 ≤ 2.5
    expect(statusOn([A, B], "2023-12-31", 9).status).toBe("NO_THRESHOLD");
    expect(ruleForDate([A, B], "2030-01-01")?.id).toBe(2);
  });
  it("overlapping or reversed ranges are reported", () => {
    expect(versionConflicts([A, B])).toEqual([]);
    expect(versionConflicts([{ ...A, effectiveTo: null }, B]).length).toBe(1);
    expect(versionConflicts([{ ...A, effectiveTo: "2025-08-01" }, B]).length).toBe(1);
    expect(versionConflicts([{ ...A, effectiveTo: "2023-01-01" }]).length).toBe(1);
  });
  it("threshold segments are clipped to the chart span and never extend backwards", () => {
    const seg = thresholdSegments([A, B], "2025-01-01", "2026-01-01");
    expect(seg.map((s) => [s.x1, s.x2])).toEqual([["2025-01-01", "2025-07-01"], ["2025-07-01", "2026-01-01"]]);
    expect(thresholdSegments([B], "2024-01-01", "2026-01-01")[0].x1).toBe("2025-07-01");
  });
  it("freshness is separate from status", () => {
    expect(freshness("quarterly", "2026-01-01", "2026-10-28")).toMatchObject({ stale: true });
    expect(freshness("quarterly", "2026-09-30", "2026-10-28").stale).toBe(false);
    expect(freshness("irregular", "2020-01-01", "2026-10-28").stale).toBe(false);
    expect(evaluateThreshold(2, lower).status).toBe("GREEN"); // unaffected by age
  });
});

describe("series transforms (spec tests 7–10)", () => {
  const q = [
    { date: "2025-12-31", value: 120 },
    { date: "2025-03-31", value: 100 },
    { date: "2025-09-30", value: 90 },
  ];
  it("clean sorts and drops non-finite values", () => {
    expect(clean([...q, { date: "2025-01-01", value: NaN }, { date: "bad", value: 1 }]).map((p) => p.date)).toEqual(["2025-03-31", "2025-09-30", "2025-12-31"]);
  });
  it("indexed base 100 from the first observation in the window; refuses zero / negative bases", () => {
    const r = indexSeries(q);
    expect(r.ok && r.points.map((p) => p.value)).toEqual([100, 90, 120]);
    expect(r.ok && r.points[2].raw).toBe(120);
    expect(indexSeries([{ date: "2025-01-01", value: 0 }, { date: "2025-02-01", value: 5 }]).ok).toBe(false);
    expect(indexSeries([{ date: "2025-01-01", value: -3 }]).ok).toBe(false);
    expect(indexSeries([]).ok).toBe(false);
    expect(baseDateWarning([{ name: "A", baseDate: "2025-01-01" }, { name: "B", baseDate: "2025-03-31" }])).toMatch(/คนละวัน/);
    expect(baseDateWarning([{ name: "A", baseDate: "2025-01-01" }, { name: "B", baseDate: "2025-01-01" }])).toBeNull();
  });
  it("% change uses the previous actual observation, refuses zero and sign changes", () => {
    const c = pctChangeSeries([
      { date: "2025-03-31", value: 100 },
      { date: "2025-12-31", value: 80 }, // sparse: 3 quarters skipped, compared with the actual previous reading
      { date: "2026-03-31", value: 0 },
      { date: "2026-06-30", value: 5 },
      { date: "2026-09-30", value: -2 },
      { date: "2026-12-31", value: -4 },
    ]);
    expect(c.map((x) => x.value)).toEqual([null, -20, -100, null, null, null]);
    expect(c[1].prevDate).toBe("2025-03-31");
    expect(c[3].reason).toMatch(/0/);
    expect(c[4].reason).toMatch(/เครื่องหมาย/);
  });
  it("latest change: pp for % units, relative change for others", () => {
    expect(latestChange([{ date: "2025-01-01", value: 3.4 }, { date: "2025-04-01", value: 3.1 }], "%")).toMatchObject({ deltaLabel: "pp", relative: null });
    expect(latestChange([{ date: "2025-01-01", value: 3.4 }, { date: "2025-04-01", value: 3.1 }], "%").delta).toBeCloseTo(-0.3, 12);
    const m = latestChange([{ date: "2025-01-01", value: 200 }, { date: "2025-04-01", value: 250 }], "THB million");
    expect(m).toMatchObject({ deltaLabel: "unit", delta: 50, relative: 0.25 });
    expect(latestChange([{ date: "2025-01-01", value: 1 }], "%").delta).toBeNull();
  });
  it("union rows keep gaps as null — no forward fill or zero fill", () => {
    const rows = unionRows([
      { key: "a", points: [{ date: "2025-03-31", value: 1 }, { date: "2025-06-30", value: 2 }] },
      { key: "b", points: [{ date: "2025-06-30", value: 10 }, { date: "2025-12-31", value: 20 }] },
    ]);
    expect(rows.map((r) => [r.date, r.a, r.b])).toEqual([["2025-03-31", 1, null], ["2025-06-30", 2, 10], ["2025-12-31", null, 20]]);
  });
  it("actual layout: same scale → one axis, two scales → two axes, 3+ scales → small multiples", () => {
    const s = (id: number, unit: string, v: number) => ({ id, name: `m${id}`, unit, points: [{ date: "2025-01-01", value: v }] });
    expect(actualLayout([s(1, "%", 3)]).kind).toBe("single");
    expect(actualLayout([s(1, "%", 3), s(2, "%", 5)]).kind).toBe("single");
    expect(actualLayout([s(1, "%", 3), s(2, "THB million", 50_000)]).kind).toBe("dual");
    expect(actualLayout([s(1, "%", 3), s(2, "%", 300)]).kind).toBe("dual"); // same unit, 100× apart
    expect(actualLayout([s(1, "%", 3), s(2, "THB million", 50_000), s(3, "times", 1.2)]).kind).toBe("small_multiples");
    expect(actualLayout([]).kind).toBe("empty");
  });
  it("window start for 1Y/3Y/5Y/All", () => {
    expect(windowStart("3Y", "2026-10-28")).toBe("2023-10-28");
    expect(windowStart("All", "2026-10-28")).toBeNull();
  });
});

describe("input validation", () => {
  it("keys normalise names (Thai kept) and decimals reject NaN / Infinity / text", () => {
    expect(metricKey("  NPL Ratio (%) ")).toBe("npl_ratio");
    expect(metricKey("อัตราส่วน NPL")).toBe("อัตราส่วน_npl");
    expect(decimal.parse("3.10")).toBe("3.10");
    expect(decimal.parse(-0.5)).toBe("-0.5");
    expect(() => decimal.parse("NaN")).toThrow();
    expect(() => decimal.parse("1e400")).toThrow();
    expect(() => decimal.parse("<script>")).toThrow();
  });
});
