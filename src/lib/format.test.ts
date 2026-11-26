import { describe, expect, it } from "vitest";
import {
  EMPTY,
  fmtPct,
  fmtQty,
  fmtThb,
  formatChange,
  formatMillions,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPercentRaw,
} from "./format";

describe("number formatting (Phase 2)", () => {
  it("empty values show — never 0/NaN/null/undefined", () => {
    for (const v of [null, undefined, NaN, Infinity]) {
      expect(formatNumber(v)).toBe(EMPTY);
      expect(formatPercent(v)).toBe(EMPTY);
      expect(formatMoney(v)).toBe(EMPTY);
      expect(formatMillions(v)).toBe(EMPTY);
      expect(formatChange(v).text).toBe(EMPTY);
    }
  });
  it("uses the true minus and thousands separators", () => {
    expect(formatPercent(-0.123)).toBe("−12.3%");
    expect(formatNumber(-1234567.891)).toBe("−1,234,567.89");
    expect(formatMoney(-1234.4)).toBe("−฿1,234");
    expect(fmtThb(2911879)).toBe("฿2,911,879");
  });
  it("never prints a negative zero", () => {
    expect(formatPercent(-0.00001)).toBe("0.0%");
    expect(formatNumber(-0.001)).toBe("0.00");
  });
  it("fixed decimals", () => {
    expect(formatPercent(0.1234)).toBe("12.3%");
    expect(fmtPct(0.1234, 2)).toBe("12.34%");
    expect(formatPercentRaw(12.34)).toBe("12.3%");
    expect(formatMillions(1_234_567)).toBe("1.2");
    expect(formatNumber(5, 0)).toBe("5");
    expect(fmtQty(12.5)).toBe("12.5");
    expect(fmtQty(100)).toBe("100");
  });
  it("change: arrow + sign + colour", () => {
    expect(formatChange(0.012)).toMatchObject({
      text: "▲ +1.2%",
      dir: "up",
      className: "text-pos",
    });
    expect(formatChange(-0.034)).toMatchObject({
      text: "▼ −3.4%",
      dir: "down",
      className: "text-neg",
    });
    expect(formatChange(0).dir).toBe("flat");
    expect(formatChange(1500, "money")).toMatchObject({ text: "▲ +฿1,500" });
  });
});
