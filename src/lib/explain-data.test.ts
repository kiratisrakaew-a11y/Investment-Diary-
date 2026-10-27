import { describe, expect, it } from "vitest";
import { compact, downsample } from "./explain-data";
import { buildExplainPrompt, explainCacheKey, explainInput } from "@/server/explain";

describe("explain payload helpers", () => {
  it("downsample keeps first and last and the requested count", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i);
    const d = downsample(xs, 10);
    expect(d).toHaveLength(10);
    expect(d[0]).toBe(0);
    expect(d[9]).toBe(99);
    expect(downsample([1, 2], 10)).toEqual([1, 2]);
  });
  it("compact rounds deeply and maps non-finite to null", () => {
    expect(compact({ a: 0.0205971834, b: [1 / 3, NaN], c: undefined, d: "x" })).toEqual({ a: 0.020597, b: [0.33333, null], d: "x" });
  });
});

describe("explain prompt", () => {
  const x = explainInput.parse({ topic: "Sharpe", page: "/analytics", data: { sharpe: 1.2 } });
  it("includes the topic, page and exact values", () => {
    const p = buildExplainPrompt(x, JSON.stringify(x.data));
    expect(p).toContain("Sharpe");
    expect(p).toContain("/analytics");
    expect(p).toContain('{"sharpe":1.2}');
  });
  it("cache key depends on the values", () => {
    const y = explainInput.parse({ topic: "Sharpe", page: "/analytics", data: { sharpe: 1.3 } });
    expect(explainCacheKey(x)).not.toBe(explainCacheKey(y));
    expect(explainCacheKey(x)).toBe(explainCacheKey(explainInput.parse({ topic: "Sharpe", page: "/analytics", data: { sharpe: 1.2 } })));
  });
});
