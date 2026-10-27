import { describe, expect, it } from "vitest";
import { valuationInput } from "./valuation-schemas";
import { runScenarios } from "./valuation-scenarios";
import { generateScenarioNoteTh, inputHash, lineDiff } from "./valuation-notes-th";
import { analyzeValuation, scenarioSnapshot } from "./valuation-analyze";

const input = valuationInput.parse({
  method: "ddm",
  assumptions: {
    d0: 1, currentPrice: 20, riskFree: 0.025, beta: 0.9, equityRiskPremium: 0.07, terminalGrowth: 0.02, highGrowth: 0.05,
    inputMeta: { asOf: "2026-10-27", rfSource: "ThaiBMA 10Y 2026-10-24" },
    scenarioSet: { scenarios: [
      { id: "bear", name: "Bear", probability: 0.25, inputOverrides: { highGrowth: 0.02 }, rationale: "ยอดขายชะลอ" },
      { id: "base", name: "Base", probability: 0.5 },
      { id: "bull", name: "Bull", probability: 0.25, inputOverrides: { highGrowth: 0.08 }, noteTh: "ของฉัน" },
    ] },
  },
});

describe("Thai notes and analysis entry point (PR15)", () => {
  it("generates the six sections from inputs only, with sources and units", () => {
    const s = runScenarios(input);
    const t = generateScenarioNoteTh(input, s, s.scenarios[0]);
    for (const h of ["สรุปง่าย ๆ", "ข้อมูลจริง", "สมมติฐาน", "วิธีคำนวณ", "ข้อจำกัด", "ความหมาย"]) expect(t).toContain(h);
    expect(t).toContain("ThaiBMA 10Y 2026-10-24");
    expect(t).toContain("highGrowth: 5.00% → 2.00%");
    expect(t).toContain("ยอดขายชะลอ");
    expect(t).toContain("ไม่ใช่คำสัญญา");
  });

  it("says when no source exists instead of inventing one", () => {
    const bare = valuationInput.parse({ method: "multiples", assumptions: { eps: 2, bookValuePerShare: 15, ebitda: 900, netDebt: 1200, sharesOutstanding: 300, currentPrice: 25, targetPE: 12, targetPBV: 1.5, targetEvEbitda: 7 } });
    const s = runScenarios(bare, { scenarios: [{ id: "a", name: "A", probability: 1, inputOverrides: {} }] });
    expect(generateScenarioNoteTh(bare, s, s.scenarios[0])).toContain("ไม่มีแหล่งที่มาระบุ");
    expect(s.qualityStatus).toBe("preliminary"); // no inputMeta.asOf
  });

  it("keeps the analyst's note, hashes ignore notes, diff lists changed lines", () => {
    const s = runScenarios(input);
    expect(s.scenarios[2].noteTh).toBe("ของฉัน");
    const a = input.assumptions as Record<string, unknown>;
    const withOtherNote = { ...a, scenarioSet: { ...(a.scenarioSet as object), scenarios: (a.scenarioSet as { scenarios: object[] }).scenarios.map((x) => ({ ...x, noteTh: "อื่น" })) } };
    expect(inputHash(withOtherNote)).toBe(inputHash(a));
    expect(inputHash({ ...a, d0: 1.1 })).not.toBe(inputHash(a));
    expect(lineDiff("a\nb", "a\nc")).toEqual({ removed: ["b"], added: ["c"] });
  });

  it("analysis returns typed partial results; snapshot keeps base and weighted apart", () => {
    const r = analyzeValuation({ valuation: input, monteCarlo: "saved", sensitivity: "default", reverse: "default" });
    expect(r.monteCarlo).toEqual({ error: expect.stringMatching(/Monte Carlo/) });
    expect("unsupported" in (r.reverse as object)).toBe(true);
    expect((r.sensitivity as { ok: boolean }).ok).toBe(true);
    const snap = scenarioSnapshot(r, "2026-10-27T00:00:00Z");
    expect(snap.scenarioAnalysis!.baseCaseValue).not.toBe(snap.scenarioAnalysis!.probabilityWeightedValue);
    expect(snap.scenarioAnalysis!.scenarios.every((x) => typeof x.generatedNoteTh === "string")).toBe(true);
  });
});
