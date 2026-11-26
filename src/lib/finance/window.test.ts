/** spec-lookback-window: presets, legacy lookbackDays, errors, quality and windowInfo (pure). */
import { describe, expect, it } from "vitest";
import { WindowError, buildWindowInfo, resolveWindow, windowQuality } from "./window";

const ctx = { settingsDefault: "3y" as const, lastPriceDate: "2026-11-20", today: "2026-11-26" };

describe("resolveWindow", () => {
  it("presets count calendar years back from the last price date", () => {
    expect(resolveWindow({ preset: "3y" }, ctx)).toMatchObject({ startDate: "2023-11-20", endDate: "2026-11-20" });
    expect(resolveWindow({ preset: "1y", endDate: "2025-12-31" }, ctx)).toMatchObject({ startDate: "2024-12-31", endDate: "2025-12-31" });
    expect(resolveWindow(undefined, ctx)).toMatchObject({ preset: "3y", startDate: "2023-11-20" });
    expect(resolveWindow({ preset: "max" }, ctx).startDate).toBeNull();
  });
  it("legacy lookbackDays = custom from the last price date; both together = WINDOW_CONFLICT", () => {
    expect(resolveWindow(undefined, { ...ctx, legacyLookbackDays: 1825 })).toMatchObject({ preset: "custom", startDate: "2021-11-21" });
    const e = (() => {
      try {
        resolveWindow({ preset: "3y" }, { ...ctx, legacyLookbackDays: 365 });
      } catch (x) {
        return x as WindowError;
      }
    })();
    expect(e?.code).toBe("WINDOW_CONFLICT");
  });
  it("INVALID_WINDOW: start after end, future end, end after the last price, custom without start, > 20 years", () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (x) {
        return (x as WindowError).code;
      }
      return null;
    };
    expect(code(() => resolveWindow({ preset: "custom", startDate: "2026-01-01", endDate: "2025-01-01" }, ctx))).toBe("INVALID_WINDOW");
    expect(code(() => resolveWindow({ preset: "3y", endDate: "2027-01-01" }, ctx))).toBe("INVALID_WINDOW");
    expect(code(() => resolveWindow({ preset: "3y", endDate: "2026-11-24" }, ctx))).toBe("INVALID_WINDOW");
    expect(code(() => resolveWindow({ preset: "custom" }, ctx))).toBe("INVALID_WINDOW");
    expect(code(() => resolveWindow({ preset: "custom", startDate: "2000-01-01" }, ctx))).toBe("INVALID_WINDOW");
  });
  it("muWindow resolves on the same end date", () => {
    expect(resolveWindow({ preset: "3y", muWindow: { preset: "10y" } }, ctx).mu).toEqual({ preset: "10y", startDate: "2016-11-20" });
  });
});

describe("quality and windowInfo", () => {
  it("≥ 10 ok · 3–10 thin · < 3 insufficient (threshold from Settings)", () => {
    expect(windowQuality(10)).toBe("ok");
    expect(windowQuality(9.9)).toBe("thin");
    expect(windowQuality(2.9)).toBe("insufficient");
    expect(windowQuality(12, 15)).toBe("thin");
  });
  it("effective < 50% of requested → warning naming the limiting asset; quality from obs per asset", () => {
    const w = resolveWindow({ preset: "3y" }, ctx);
    const info = buildWindowInfo({
      requested: w,
      maxStart: null,
      effective: { startDate: "2025-11-09", endDate: "2026-11-20", observations: 56, frequency: "weekly" },
      nAssets: 27,
      limitedBy: [{ symbol: "MRDIYT", firstDate: "2025-11-09" }],
      dropped: [],
    });
    expect(info.quality).toBe("insufficient");
    expect(info.obsPerAsset).toBeCloseTo(56 / 27, 12);
    expect(info.warnings.join(" ")).toMatch(/MRDIYT เริ่ม 2025-11-09/);
    expect(info.effective!.years).toBeCloseTo(1.03, 1);
  });
});
