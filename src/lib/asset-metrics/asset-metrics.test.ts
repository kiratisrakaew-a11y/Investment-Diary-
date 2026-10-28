/** Asset custom metrics: threshold semantics, effective dating and scale-safe series (pure). */
import { describe, expect, it } from "vitest";
import { evaluateThreshold, freshness, ruleForDate, statusOn, validateRule, versionConflicts, type ThresholdVersion } from "./thresholds";
import { chartDomain, clean, indexSeries, latestChange, metricCharts, pctChangeSeries, singleMetricChart, thresholdSegments, windowStart, type ChartMode } from "./series";
import { decimal, metricDefinitionPatch, metricKey, thresholdInput } from "./schemas";

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

describe("metric definition patch", () => {
  it("a partial update leaves omitted defaulted fields untouched (no frequency / decimals reset)", () => {
    expect(metricDefinitionPatch.parse({ name: "NPL" })).toEqual({ name: "NPL" });
    expect(metricDefinitionPatch.parse({ decimals: 4 })).toEqual({ decimals: 4 });
  });
});

describe("one independent chart per metric (separate-charts spec)", () => {
  const MODES: ChartMode[] = ["actual", "indexed", "change"];
  const q = ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31"];
  const mk = (id: number, values: number[], extra: { frequency?: string; thresholdBounds?: number[] } = {}) => ({
    id,
    points: values.map((value, i) => ({ date: q[i], value })),
    observationCount: values.length,
    frequency: "quarterly",
    ...extra,
  });
  const npl = mk(1, [3.1, 2.9, 2.7, 2.5], { thresholdBounds: [2.5, 3.5] }); // %
  const coverage = mk(2, [150, 160, 170, 180], { thresholdBounds: [150, 180] }); // % (same unit, 50× scale)
  const profit = mk(3, [9000, 9500, 10_000, 11_000]); // THB million
  const growth = mk(4, [4, 5, 6, 7]); // %
  const branches = mk(5, [1000, 1010, 1020, 1030]); // count

  const cases: [string, ReturnType<typeof mk>[]][] = [
    ["1 metric", [npl]],
    ["2 metrics, same unit", [npl, growth]],
    ["2 metrics, different units", [npl, profit]],
    ["2 metrics, different scales", [npl, coverage]],
    ["5 metrics", [npl, coverage, profit, growth, branches]],
  ];
  for (const mode of MODES)
    for (const [label, ms] of cases)
      it(`${mode}: ${label} → ${ms.length} chart(s), each with only its own data`, () => {
        const charts = metricCharts(ms, mode);
        expect(charts.map((c) => c.id)).toEqual(ms.map((m) => m.id));
        for (const [k, c] of charts.entries()) {
          expect(c.empty).toBeNull();
          // Rows are this metric's own observations: same dates, raw values from this metric only.
          expect(c.rows.filter((r) => !r.gap).map((r) => r.raw)).toEqual(ms[k].points.map((p) => p.value));
          expect(c.rows.every((r) => r.value == null || Number.isFinite(r.value))).toBe(true);
          expect(c.domain!.every(Number.isFinite)).toBe(true);
        }
      });

  it("scale comes from the metric itself (and its own thresholds in actual mode)", () => {
    const [a, b] = metricCharts([npl, coverage], "actual");
    expect(a.domain![1]).toBeLessThan(10); // NPL axis is not stretched by Coverage (≈150–180)
    expect(b.domain![0]).toBeGreaterThan(100);
    expect(a.domain![0]).toBeLessThanOrEqual(2.5);
    expect(a.domain![1]).toBeGreaterThanOrEqual(3.5); // own yellow bound visible
  });

  it("raw threshold bands only on the actual axis; indexed / % change domains ignore raw bounds", () => {
    expect(singleMetricChart(npl, "actual").bands).toBe(true);
    for (const mode of ["indexed", "change"] as const) {
      const c = singleMetricChart(coverage, mode);
      expect(c.bands).toBe(false);
      // Coverage bounds 150 / 180 are not mixed into transformed axes.
      expect(c.domain![1]).toBeLessThan(150);
    }
    expect(singleMetricChart(coverage, "indexed").reference).toBe(100);
    expect(singleMetricChart(coverage, "change").reference).toBe(0);
  });

  it("indexed: each metric uses its own first observation as base", () => {
    const [a, b] = metricCharts([npl, coverage], "indexed");
    expect(a.baseValue).toBe(3.1);
    expect(b.baseValue).toBe(150);
    expect(a.rows[0].value).toBe(100);
    expect(b.rows[3].value).toBeCloseTo(120, 12);
  });

  it("no observations / none in window still get a card with an empty state", () => {
    const empty = { id: 9, points: [], observationCount: 0, frequency: "quarterly" };
    const outOfWindow = { id: 10, points: [], observationCount: 4, frequency: "quarterly" };
    for (const mode of MODES) {
      const charts = metricCharts([npl, empty, outOfWindow], mode);
      expect(charts).toHaveLength(3);
      expect(charts[1].empty).toMatch(/ยังไม่มีค่า/);
      expect(charts[2].empty).toMatch(/ช่วงเวลาที่เลือก/);
      expect(charts[1].rows).toEqual([]);
      expect(charts[0].empty).toBeNull();
    }
  });

  it("invalid indexed base affects only that metric's chart", () => {
    const zeroBase = mk(11, [0, 2, 3]);
    const negative = mk(12, [-1, 2]);
    const [z, n, ok] = metricCharts([zeroBase, negative, npl], "indexed");
    expect(z.empty).toMatch(/ไม่เป็นบวก/);
    expect(n.empty).toMatch(/ไม่เป็นบวก/);
    expect(z.rows).toEqual([]);
    expect(ok.empty).toBeNull();
    expect(ok.rows.map((r) => r.value)).toEqual([100, (100 * 2.9) / 3.1, (100 * 2.7) / 3.1, (100 * 2.5) / 3.1]);
  });

  it("% change keeps nulls with reasons; nothing computable → empty state with reason", () => {
    const c = singleMetricChart(mk(13, [100, 0, 5, 6]), "change");
    expect(c.rows.map((r) => r.value)).toEqual([null, -100, null, 20]);
    expect(c.rows[2].reason).toMatch(/0/);
    expect(c.notes[0]).toMatch(/1 จุด/);
    expect(singleMetricChart(mk(14, [5]), "change").empty).toMatch(/อย่างน้อย 2 ค่า/);
    expect(singleMetricChart(mk(15, [0, 5]), "change").empty).toMatch(/0/);
  });

  it("missing periods become null gap markers, never values; observations are not added", () => {
    const sparse = { id: 16, points: [{ date: "2023-03-31", value: 1 }, { date: "2023-06-30", value: 2 }, { date: "2024-06-30", value: 3 }], observationCount: 3, frequency: "quarterly" };
    for (const mode of ["actual", "indexed"] as const) {
      const c = singleMetricChart(sparse, mode);
      const gaps = c.rows.filter((r) => r.gap);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject({ value: null, raw: null });
      expect(gaps[0].date > "2023-06-30" && gaps[0].date < "2024-06-30").toBe(true);
      expect(c.rows.filter((r) => !r.gap)).toHaveLength(3);
    }
    // Irregular frequency: no expected period, so no gap markers.
    expect(singleMetricChart({ ...sparse, frequency: "irregular" }, "actual").rows.some((r) => r.gap)).toBe(false);
  });

  it("chartDomain ignores non-finite values and never returns NaN", () => {
    expect(chartDomain([])).toBeNull();
    expect(chartDomain([NaN, Infinity])).toBeNull();
    const d = chartDomain([5, 5]);
    expect(d!.every(Number.isFinite) && d![0] < 5 && d![1] > 5).toBe(true);
  });
});
