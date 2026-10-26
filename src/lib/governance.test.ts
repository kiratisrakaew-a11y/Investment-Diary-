/**
 * PR 5 / Phase F regression tests — assumption governance, provenance and data quality.
 */
import { describe, expect, it } from "vitest";
import {
  MODEL_VERSION,
  assessDataQuality,
  defaultInputMeta,
  exportValuationFile,
  marketInputProvenance,
  parseValuationImport,
  rateScaleWarnings,
} from "./governance";
import { specFromBondAsset } from "./finance/bonds";
import { explainValuation } from "./valuation-explain";
import { DEFAULT_DCF } from "./finance/valuation";

const settings = { riskFreeRate: 2.5, equityRiskPremium: 7, rfSource: null, rfAsOf: null, rfSeries: null, erpSource: null, erpAsOf: null };

describe("F2 illustrative defaults are never presented as market data", () => {
  it("unsourced Rf / ERP are flagged illustrative", () => {
    const p = marketInputProvenance(settings);
    expect(p.riskFree.illustrative).toBe(true);
    expect(p.erp.illustrative).toBe(true);
    expect(p.riskFree.label).toContain("ตัวอย่าง");
  });
  it("sourced inputs carry source and date into new valuations", () => {
    const s = { ...settings, rfSource: "ThaiBMA", rfSeries: "พันธบัตรรัฐบาล 10 ปี", rfAsOf: "2026-10-24", erpSource: "Damodaran Jan-2026", erpAsOf: "2026-01-05" };
    expect(marketInputProvenance(s).riskFree.illustrative).toBe(false);
    const meta = defaultInputMeta(s, { beta: 1.1, observations: 480, benchmark: "^SET.BK" });
    expect(meta.rfSource).toContain("ThaiBMA");
    expect(meta.rfSource).toContain("10 ปี");
    expect(meta.erpSource).toBe("Damodaran Jan-2026");
    expect(meta.betaSource).toContain("^SET.BK");
    expect(meta.asOf).toBe("2026-10-24");
  });
  it("unsourced settings leave the valuation sources empty (shown as illustrative)", () => {
    const meta = defaultInputMeta(settings, null);
    expect(meta.rfSource).toBeUndefined();
    const e = explainValuation({ method: "dcf_fcff", assumptions: { ...DEFAULT_DCF, inputMeta: meta } })!;
    expect(e.assumptions.find((a) => a.label.startsWith("Risk-free"))!.note).toContain("ตัวอย่าง");
  });
});

describe("F2 percent / decimal scaling guard", () => {
  it("flags rates that look like percentages passed as decimals", () => {
    const w = rateScaleWarnings({ riskFree: 2.5, equityRiskPremium: 0.06, terminalGrowth: 3 });
    expect(w.some((x) => x.includes("Risk-free"))).toBe(true);
    expect(w.some((x) => x.includes("Terminal growth"))).toBe(true);
    expect(w.some((x) => x.includes("ERP"))).toBe(false);
  });
  it("valuation explanations surface the scaling warning near the result", () => {
    const e = explainValuation({ method: "dcf_fcff", assumptions: { ...DEFAULT_DCF, riskFree: 2.5 } })!;
    expect(e.warnings.some((w) => w.includes("Risk-free"))).toBe(true);
  });
});

describe("F1 assumption versioning and import / export", () => {
  it("export → import round trip keeps assumptions, sources and model version", () => {
    const valuation = { method: "dcf_fcff" as const, assumptions: { ...DEFAULT_DCF, inputMeta: { rfSource: "ThaiBMA 10Y", asOf: "2026-10-24" } } };
    const file = exportValuationFile({ symbol: "PTT", title: "Base", note: "n", valuation });
    expect(file.modelVersion).toBe(MODEL_VERSION);
    const back = parseValuationImport(JSON.stringify(file));
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.symbol).toBe("PTT");
      expect(back.valuation.method).toBe("dcf_fcff");
      expect((back.valuation.assumptions as { inputMeta?: { rfSource?: string } }).inputMeta?.rfSource).toBe("ThaiBMA 10Y");
    }
  });
  it("older files without new fields get safe defaults; malformed files are rejected", () => {
    const { terminalRoic: _a, terminalRoe: _b, debtPolicy: _c, ...old } = DEFAULT_DCF;
    const r = parseValuationImport(JSON.stringify({ method: "dcf_fcfe", assumptions: old }));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.valuation.assumptions as { debtPolicy: string }).debtPolicy).toBe("fixed_borrowing_ratio");
    expect(parseValuationImport("{not json").ok).toBe(false);
    expect(parseValuationImport(JSON.stringify({ method: "dcf_fcff", assumptions: { revenue0: "x" } })).ok).toBe(false);
  });
});

describe("F2 data-quality panel", () => {
  it("collects stale prices, illustrative inputs, inferred cash and outdated valuations", () => {
    const r = assessDataQuality({
      provenance: marketInputProvenance(settings),
      positions: [
        { symbol: "AAA", priceStatus: "stale", priceAgeDays: 20, fxStatus: "not_applicable" },
        { symbol: "BBB", priceStatus: "market", priceAgeDays: 1, fxStatus: "tx_fallback" },
      ],
      reconciliation: { navMatches: true, inferredContributionsThb: 1000 },
      ledgerIssues: [{ code: "OVERSELL", severity: "warning", message: "x" }],
      benchmark: { symbol: "^SET.BK", lastDate: "2026-01-01", kind: "price_index" },
      today: "2026-10-26",
      valuations: [{ id: 1, symbol: "PTT", modelVersion: undefined }, { id: 2, symbol: "PTT", modelVersion: MODEL_VERSION }],
      bonds: [{ symbol: "LB29DA", conventionsSet: false }],
    });
    const areas = r.checks.filter((c) => c.status !== "ok").map((c) => c.area);
    for (const a of ["ราคา", "อัตราแลกเปลี่ยน", "สมมติฐานตลาด", "เงินสด", "รายการ", "ดัชนีอ้างอิง", "Valuation", "พันธบัตร"]) expect(areas).toContain(a);
    expect(r.status).toBe("warnings");
  });
  it("clean data reports ok", () => {
    const r = assessDataQuality({
      provenance: marketInputProvenance({ ...settings, rfSource: "ThaiBMA", rfAsOf: "2026-10-24", erpSource: "Damodaran", erpAsOf: "2026-01-05" }),
      positions: [{ symbol: "AAA", priceStatus: "market", priceAgeDays: 1, fxStatus: "market" }],
      reconciliation: { navMatches: true, inferredContributionsThb: 0 },
      ledgerIssues: [],
      benchmark: { symbol: "^SET.BK", lastDate: "2026-10-24", kind: "total_return" },
      today: "2026-10-26",
      valuations: [{ id: 2, symbol: "PTT", modelVersion: MODEL_VERSION }],
      bonds: [{ symbol: "LB29DA", conventionsSet: true }],
    });
    expect(r.status).toBe("ok");
  });
});

describe("F2 portfolio bonds use their stored conventions", () => {
  it("frequency and day count come from the asset, with an explicit default disclosure", () => {
    const s = specFromBondAsset({ couponRate: 2.4, maturityDate: "2029-12-17", couponFrequency: 1, dayCount: "ACT/365F" }, "2026-10-26");
    expect(s.spec.frequency).toBe(1);
    expect(s.spec.dayCount).toBe("ACT/365F");
    expect(s.assumed).toEqual([]);
    const d = specFromBondAsset({ couponRate: 2.4, maturityDate: "2029-12-17", couponFrequency: null, dayCount: null }, "2026-10-26");
    expect(d.spec.frequency).toBe(2);
    expect(d.assumed.length).toBe(2);
  });
});

describe("Roadmap phase 1: price-history check", () => {
  it("flags held assets below the optimizer's minimum history", () => {
    const r = assessDataQuality({
      provenance: marketInputProvenance({ ...settings, rfSource: "ThaiBMA", rfAsOf: "2026-10-24", erpSource: "Damodaran", erpAsOf: "2026-01-05" }),
      positions: [],
      reconciliation: { navMatches: true, inferredContributionsThb: 0 },
      ledgerIssues: [],
      benchmark: { symbol: "^SET.BK", lastDate: "2026-10-24", kind: "total_return" },
      today: "2026-10-26",
      valuations: [],
      bonds: [],
      history: [
        { symbol: "PTT", observations: 240, lookbackDays: 365 },
        { symbol: "KBANK", observations: 12, lookbackDays: 365 },
      ],
    });
    const h = r.checks.find((c) => c.area === "ประวัติราคา")!;
    expect(h.status).toBe("warn");
    expect(h.message).toContain("KBANK (12)");
    expect(h.message).not.toContain("PTT");
  });
});
