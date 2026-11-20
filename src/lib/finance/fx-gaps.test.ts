/** MPT_FIX_SPEC P0-B2: USDTHB gaps over the price history (pure). */
import { describe, expect, it } from "vitest";
import { fxGapsFor } from "../governance";

describe("fxGapsFor", () => {
  const fx: [string, number][] = [
    ["2025-01-02", 34],
    ["2025-01-03", 34.1],
    ["2025-01-20", 34.2],
  ];
  it("counts price dates whose latest fixing is more than 5 days old, or missing", () => {
    const r = fxGapsFor("X", ["2025-01-01", "2025-01-03", "2025-01-08", "2025-01-09", "2025-01-20"], fx);
    expect(r.days).toBe(2); // 01-01 (no earlier rate) and 01-09 (6 days); 01-08 is exactly 5 → ok
    expect(r.sample).toEqual(["2025-01-01", "2025-01-09"]);
  });
  it("complete fixings → no gap", () => {
    expect(fxGapsFor("X", ["2025-01-02", "2025-01-03"], fx).days).toBe(0);
  });
});
