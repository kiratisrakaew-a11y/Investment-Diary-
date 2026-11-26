import { describe, expect, it } from "vitest";
import { pageBenchmark, parseSelection, periodUnit } from "./universe-selection";

const catalog = ["PTT", "CPALL", "AAPL", "K-FIXED"];
describe("parseSelection", () => {
  it("no sel = every asset; empty = none (never all); unknown symbols and duplicates dropped; case-insensitive", () => {
    expect(parseSelection(undefined, catalog)).toEqual(catalog);
    expect(parseSelection("", catalog)).toEqual([]);
    expect(parseSelection("ptt, AAPL ,ptt,NOPE", catalog)).toEqual(["PTT", "AAPL"]);
  });
});
describe("pageBenchmark", () => {
  it("total_return + default → auto; a user's choice is never overridden; price_return keeps default", () => {
    expect(pageBenchmark("total_return", "default")).toBe("auto");
    expect(pageBenchmark("total_return", undefined)).toBe("auto");
    expect(pageBenchmark("total_return", "^SET.BK")).toBe("^SET.BK");
    expect(pageBenchmark("price_return", "default")).toBe("default");
    expect(pageBenchmark("total_return", "SETTRI")).toBe("SETTRI");
  });
});
describe("periodUnit", () => {
  it("unit by frequency", () => {
    expect(periodUnit("weekly")).toBe("สัปดาห์");
    expect(periodUnit("monthly")).toBe("เดือน");
    expect(periodUnit("daily")).toBe("วัน");
    expect(periodUnit(undefined)).toBe("วัน");
  });
});
