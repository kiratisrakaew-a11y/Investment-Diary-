/** View model of the asset page section: every state, shared dates with the price chart, range, markers. */
import { describe, expect, it } from "vitest";
import {
  chartRows,
  flagRows,
  markers,
  qualityNotes,
  rangeDomain,
  statusBadge,
  ts,
  viewState,
  type AbnormalOverview,
  type OverviewDay,
} from "./view";

const day = (date: string, o: Partial<OverviewDay> = {}): OverviewDay => ({
  date,
  ar: 0.001,
  tAR: 0.1,
  car5: 0.002,
  tCAR5: 0.2,
  z: 0.3,
  volume: 1000,
  level: "ปกติ",
  reasons: [],
  missing: [],
  warnings: [],
  sigma: 0.02,
  preEvent: null,
  ...o,
});
const flag = (date: string, level: "ผิดปกติ" | "น่าสังเกต") => ({
  ...day(date, { level, reasons: ["r"] }),
  beta: 1,
  n: 221,
  preEventLabel: null,
});
function overview(
  o: {
    days?: OverviewDay[];
    flagged?: ReturnType<typeof flag>[];
    coverage?: { days: number; withAR: number; withVolumeZ: number };
    warnings?: string[];
  } = {},
): AbnormalOverview {
  const days = o.days ?? [
    day("2026-01-05"),
    day("2026-01-06"),
    day("2026-01-07"),
  ];
  return {
    modelLabel: "Market model",
    estimationWindow: [-250, -30],
    thresholds: { notable: 2, abnormal: 3 },
    criteria: { ผิดปกติ: "x", น่าสังเกต: "y", preEvent: "z" },
    stock: {
      symbol: "AAA",
      level: "ปกติ",
      benchmark: {
        basis: "price",
        symbol: "^SET.BK",
        label: "^SET.BK (ดัชนีราคา)",
      },
      volumeBasis: "raw_volume",
      coverage: o.coverage ?? {
        days: days.length,
        withAR: days.length,
        withVolumeZ: days.length,
      },
      flagged: o.flagged ?? [],
      volumeOnly: [],
      days,
      warnings: o.warnings ?? [],
    },
    events: [
      {
        id: 1,
        eventDate: "2026-01-07",
        eventType: "news",
        description: "ข่าว A",
        source: null,
        origin: "stock_events",
      },
    ],
    sharesOutstanding: [],
    disclaimer: "เป็นสัญญาณทางสถิติ ไม่ใช่หลักฐานการกระทำผิด",
  };
}

describe("viewState", () => {
  it("loading / error", () => {
    expect(viewState(null, null, true).kind).toBe("loading");
    expect(viewState(null, "boom", false)).toEqual({
      kind: "error",
      message: "boom",
    });
  });
  it("insufficient: no prices, or neither AR nor volume z computable (with the reasons)", () => {
    expect(
      viewState(
        overview({
          days: [],
          coverage: { days: 0, withAR: 0, withVolumeZ: 0 },
        }),
        null,
        false,
      ),
    ).toEqual({ kind: "insufficient", reasons: ["ยังไม่มีประวัติราคา"] });
    const s = viewState(
      overview({
        coverage: { days: 3, withAR: 0, withVolumeZ: 0 },
        warnings: ["ไม่มีข้อมูลดัชนี"],
      }),
      null,
      false,
    );
    expect(s).toEqual({ kind: "insufficient", reasons: ["ไม่มีข้อมูลดัชนี"] });
  });
  it("no flags / flags; volume-only data is shown with the limit stated", () => {
    expect(viewState(overview(), null, false)).toEqual({
      kind: "no_flags",
      limits: [],
    });
    expect(
      viewState(
        overview({ flagged: [flag("2026-01-06", "ผิดปกติ")] }),
        null,
        false,
      ).kind,
    ).toBe("flags");
    const v = viewState(
      overview({ coverage: { days: 3, withAR: 0, withVolumeZ: 3 } }),
      null,
      false,
    );
    expect(v.kind).toBe("no_flags");
    expect(v.kind === "no_flags" && v.limits[0]).toMatch(/AR \/ CAR ไม่ได้/);
  });
  it("a refetch keeps the previous data on screen", () =>
    expect(viewState(overview(), null, true).kind).toBe("no_flags"));
});

describe("range and chart rows", () => {
  const dates = [
    "2022-06-01",
    "2025-11-18",
    "2026-01-05",
    "2026-01-06",
    "2026-01-07",
  ];
  it("range domain counts back from the last price date and never before the first", () => {
    expect(rangeDomain(dates, "ALL")).toEqual([
      ts("2022-06-01"),
      ts("2026-01-07"),
    ]);
    expect(rangeDomain(dates, "1Y")).toEqual([
      ts("2025-01-07"),
      ts("2026-01-07"),
    ]);
    expect(rangeDomain(dates, "5Y")).toEqual([
      ts("2022-06-01"),
      ts("2026-01-07"),
    ]);
    expect(rangeDomain([], "1Y")).toBeNull();
  });
  it("one row per price date in range (same x values as the price chart); no scan value → nulls, nothing filled", () => {
    const rows = chartRows(
      dates,
      [day("2026-01-06", { ar: 0.05, sigma: 0.01, car5: null })],
      rangeDomain(dates, "1Y"),
    );
    expect(rows.map((r) => r.date)).toEqual([
      "2025-11-18",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
    ]);
    expect(rows[0]).toMatchObject({
      arPct: null,
      z: null,
      bandPct: null,
      level: "ปกติ",
    });
    expect(rows[2].arPct).toBeCloseTo(5, 12);
    expect(rows[2].bandPct).toBeCloseTo(2, 12);
    expect(rows[2].car5Pct).toBeNull();
  });
});

describe("badge, table, markers, notes", () => {
  const data = overview({
    flagged: [flag("2026-01-06", "ผิดปกติ"), flag("2025-03-01", "น่าสังเกต")],
  });
  const dom: [number, number] = [ts("2026-01-01"), ts("2026-01-31")];
  it("badge counts flags in the visible range and shows the latest level", () => {
    const b = statusBadge(data, dom);
    expect(b).toMatchObject({
      worst: "ผิดปกติ",
      abnormal: 1,
      notable: 0,
      latestDate: "2026-01-07",
      latestLevel: "ปกติ",
    });
    expect(statusBadge(data, null)).toMatchObject({ abnormal: 1, notable: 1 });
    expect(statusBadge(overview(), null).text).toMatch(/ไม่พบ/);
  });
  it("table keeps the service order and reports flags outside the range", () => {
    expect(flagRows(data, dom)).toMatchObject({
      rows: [{ date: "2026-01-06" }],
      hidden: 1,
    });
    expect(flagRows(data, null).rows.map((r) => r.date)).toEqual([
      "2026-01-06",
      "2025-03-01",
    ]);
  });
  it("markers: events and flags inside the range, sorted by date", () => {
    const m = markers(data, dom);
    expect(m.map((x) => [x.date, x.kind])).toEqual([
      ["2026-01-06", "flag"],
      ["2026-01-07", "event"],
    ]);
    expect(m[1].label).toBe("ข่าว: ข่าว A");
  });
  it("quality notes include the raw-volume fallback", () =>
    expect(qualityNotes(data)).toContain("ใช้ raw volume แทน turnover"));
});
