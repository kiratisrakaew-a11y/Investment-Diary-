/** PRICE_BASIS_BENCHMARK_SPEC 6.3: benchmark resolver — default / auto / explicit / mismatch / not found / coverage. */
import { describe, expect, it } from "vitest";
import {
  BenchmarkError,
  resolveBenchmarkWith,
  type BenchmarkContext,
} from "./benchmark-resolve";
import { resolveReturnBasis } from "./price-basis";

const series = (from: string, n = 30): [string, number][] =>
  Array.from({ length: n }, (_, i) => [
    new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10),
    100 + i,
  ]);

const data: Record<string, [string, number][]> = {
  "^SET.BK": series("2024-01-01"),
  SETTRI: series("2024-01-01"),
  LATE: series("2024-06-01"),
};
const ctx = (over: Partial<BenchmarkContext["settings"]> = {}): BenchmarkContext => ({
  settings: { benchmarkSymbol: "^SET.BK", benchmarkKind: "price_index", ...over },
  registry: new Map([
    ["SETTRI", "total_return"],
    ["^SET.BK", "price_index"],
    ["LATE", "price_index"],
  ]),
  list: Object.entries(data).map(([symbol, s]) => ({
    symbol,
    kind: symbol === "SETTRI" ? "total_return" : "price_index",
    label: null,
    from: s[0][0],
    to: s[s.length - 1][0],
    days: s.length,
  })),
  load: async (symbol, from) =>
    (data[symbol] ?? []).filter(([d]) => !from || d >= from),
});

describe("6.3 benchmark resolver", () => {
  it("default + settings rule → Settings' index unchanged; total_return warns (B1)", async () => {
    const p = await resolveBenchmarkWith(
      { wanted: "price", featureDefault: "settings" },
      ctx(),
    );
    expect(p).toMatchObject({ symbol: "^SET.BK", source: "default", warning: null });
    const t = await resolveBenchmarkWith(
      { wanted: "total_return", featureDefault: "settings" },
      ctx(),
    );
    expect(t?.symbol).toBe("^SET.BK");
    expect(t?.warning).toMatch(/basis ไม่ตรง/);
  });
  it("default + basis rule → same as benchmarkForBasis (TRI for total return)", async () => {
    const r = await resolveBenchmarkWith(
      { wanted: "total_return", from: "2024-01-01", featureDefault: "basis" },
      ctx(),
    );
    expect(r).toMatchObject({ symbol: "SETTRI", kind: "total_return", warning: null });
  });
  it("auto → the kind that matches the basis", async () => {
    const t = await resolveBenchmarkWith(
      { request: "auto", wanted: "total_return", from: "2024-01-02", featureDefault: "settings" },
      ctx(),
    );
    expect(t).toMatchObject({ symbol: "SETTRI", source: "auto", warning: null });
    const p = await resolveBenchmarkWith(
      { request: "AUTO", wanted: "price", from: "2024-01-02", featureDefault: "settings" },
      ctx(),
    );
    expect(p).toMatchObject({ symbol: "^SET.BK", source: "auto" });
  });
  it("explicit, kind matches → no warning", async () => {
    const r = await resolveBenchmarkWith(
      { request: "settri", wanted: "total_return", from: "2024-01-05", featureDefault: "settings" },
      ctx(),
    );
    expect(r).toMatchObject({ symbol: "SETTRI", source: "explicit", warning: null });
    expect(r?.series[0][0]).toBe("2024-01-05");
  });
  it("explicit, kind differs → computed with a warning", async () => {
    const r = await resolveBenchmarkWith(
      { request: "^SET.BK", wanted: "total_return", featureDefault: "settings" },
      ctx(),
    );
    expect(r?.symbol).toBe("^SET.BK");
    expect(r?.warning).toMatch(/basis ไม่ตรง/);
  });
  it("unknown index → BENCHMARK_NOT_FOUND listing the indexes", async () => {
    const e = await resolveBenchmarkWith(
      { request: "NOPE", wanted: "price", featureDefault: "settings" },
      ctx(),
    ).catch((x) => x);
    expect(e).toBeInstanceOf(BenchmarkError);
    expect(e.code).toBe("BENCHMARK_NOT_FOUND");
    expect(e.available).toEqual(["^SET.BK", "SETTRI", "LATE"]);
  });
  it("index starting after the period → BENCHMARK_COVERAGE", async () => {
    const e = await resolveBenchmarkWith(
      { request: "LATE", wanted: "price", from: "2024-01-01", featureDefault: "settings" },
      ctx(),
    ).catch((x) => x);
    expect(e.code).toBe("BENCHMARK_COVERAGE");
  });
  it("Settings' benchmark keeps Settings' kind", async () => {
    const r = await resolveBenchmarkWith(
      { request: "^SET.BK", wanted: "total_return", featureDefault: "settings" },
      ctx({ benchmarkKind: "total_return" }),
    );
    expect(r).toMatchObject({ kind: "total_return", warning: null });
  });
});

describe("resolveReturnBasis", () => {
  it("request → settings → feature default", () => {
    expect(resolveReturnBasis("total_return", "price_return", "price_return")).toEqual({
      requested: "total_return",
      used: "total_return",
      source: "request",
    });
    expect(resolveReturnBasis(undefined, "total_return", "price_return").source).toBe("settings");
    expect(resolveReturnBasis(undefined, null, "price_return")).toEqual({
      requested: null,
      used: "price_return",
      source: "feature_default",
    });
  });
});
