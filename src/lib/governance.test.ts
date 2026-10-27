/**
 * PR 5 / Phase F regression tests — assumption governance, provenance and data quality.
 */
import { describe, expect, it } from "vitest";
import {
  MODEL_VERSION,
  assessDataQuality,
  timestampFlags,
  priceDateAt,
  statementsAsOfAt,
  readTimestampPolicy,
  DEFAULT_TIMESTAMP_POLICY,
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

describe("val6: version labels and timestamp flags", () => {
  const clean = {
    provenance: marketInputProvenance({ ...settings, rfSource: "ThaiBMA", rfAsOf: "2026-10-24", erpSource: "Damodaran", erpAsOf: "2026-01-05" }),
    positions: [],
    reconciliation: { navMatches: true, inferredContributionsThb: 0 },
    ledgerIssues: [],
    benchmark: { symbol: "^SET.BK", lastDate: "2026-10-24", kind: "total_return" as const },
    today: "2026-10-26",
    bonds: [],
  };
  it("an older version whose value recomputes identically is ok; a changed or unknown one warns", () => {
    const same = assessDataQuality({ ...clean, valuations: [{ id: 1, symbol: "PTT", modelVersion: "2026.10-pr5", valueChanged: false }] });
    expect(same.checks.find((c) => c.area === "Valuation")!.status).toBe("ok");
    const changed = assessDataQuality({ ...clean, valuations: [{ id: 1, symbol: "PTT", modelVersion: "2026.10-pr5", valueChanged: true }] });
    expect(changed.checks.find((c) => c.area === "Valuation")!.status).toBe("warn");
    const unknown = assessDataQuality({ ...clean, valuations: [{ id: 1, symbol: "PTT", modelVersion: undefined }] });
    expect(unknown.checks.find((c) => c.area === "Valuation")!.status).toBe("warn");
  });
  it("flags stale, future-dated or mismatched timestamps and nothing when consistent", () => {
    expect(timestampFlags({ valuationDate: "2026-10-27", inputsAsOf: "2026-10-01", priceDate: "2026-10-25", statementsAsOf: "2025-12-31" })).toEqual([]);
    expect(timestampFlags({ valuationDate: "2026-10-27", inputsAsOf: "2026-01-05" })[0]).toMatch(/เก่ากว่าวันประเมิน 295 วัน/);
    expect(timestampFlags({ valuationDate: "2026-10-27", inputsAsOf: "2026-11-01" })[0]).toMatch(/หลังวันประเมิน/);
    expect(timestampFlags({ valuationDate: "2026-10-27", priceDate: "2026-10-01" })[0]).toMatch(/26 วัน/);
    expect(timestampFlags({ valuationDate: "2026-10-27", statementsAsOf: "2024-12-31" })[0]).toMatch(/เกณฑ์ 548 วัน/);
    expect(timestampFlags({ valuationDate: "2026-10-27", statementsAsOf: "2026-12-31" })[0]).toMatch(/look-ahead/);
    expect(timestampFlags({ valuationDate: "bad", inputsAsOf: "2020-01-01" })).toEqual([]);
  });
});

describe("phase 2: configurable timestamp policy", () => {
  it("thresholds come from the policy; defaults fill anything missing or invalid", () => {
    const x = { valuationDate: "2026-10-27", inputsAsOf: "2026-07-01", priceDate: "2026-10-20" };
    expect(timestampFlags(x)).toEqual([]); // 118 days ≤ 180, 7 days ≤ 7
    const strict = readTimestampPolicy({ inputsMaxAgeDays: 90, priceMaxGapDays: 3 });
    expect(strict.statementsMaxAgeDays).toBe(548);
    const f = timestampFlags(x, strict);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatch(/118 วัน \(เกณฑ์ 90 วัน\)/);
    expect(f[1]).toMatch(/7 วัน \(เกณฑ์ 3 วัน\)/);
    expect(readTimestampPolicy({ priceMaxGapDays: -5 })).toEqual(DEFAULT_TIMESTAMP_POLICY);
    expect(readTimestampPolicy(null)).toEqual(DEFAULT_TIMESTAMP_POLICY);
  });
  it("price and statement dates are taken as of the valuation date, never after it", () => {
    expect(priceDateAt(["2026-10-01", "2026-10-20", "2026-10-28"], "2026-10-27")).toBe("2026-10-20");
    expect(priceDateAt(["2026-11-01"], "2026-10-27")).toBeNull();
    expect(statementsAsOfAt([2023, 2024, 2025, 2026], "2026-10-27")).toEqual({ asOf: "2025-12-31", label: "ปีบัญชี 2025 (ถือว่าสิ้นปี 31 ธ.ค.)" });
    expect(statementsAsOfAt([2026], "2026-10-27")).toBeNull();
    const s = statementsAsOfAt([2023], "2026-10-27")!;
    expect(timestampFlags({ valuationDate: "2026-10-27", statementsAsOf: s.asOf, statementsLabel: s.label })[0]).toMatch(/ปีบัญชี 2023/);
  });
});

describe("phase 2: data-quality check for valuation dates", () => {
  const clean = {
    provenance: marketInputProvenance({ ...settings, rfSource: "ThaiBMA", rfAsOf: "2026-10-24", erpSource: "Damodaran", erpAsOf: "2026-01-05" }),
    positions: [],
    reconciliation: { navMatches: true, inferredContributionsThb: 0 },
    ledgerIssues: [],
    benchmark: { symbol: "^SET.BK", lastDate: "2026-10-24", kind: "total_return" as const },
    today: "2026-10-26",
    bonds: [],
    valuations: [],
  };
  it("warns with the first flag per valuation; ok when none; absent input adds no check", () => {
    const bad = assessDataQuality({ ...clean, valuationDates: [{ symbol: "PTT", method: "ddm", date: "2026-10-26", flags: ["a", "b"] }, { symbol: "PTT", method: "dcf_fcff", date: "2026-10-26", flags: [] }] });
    const c = bad.checks.find((x) => x.area === "วันที่ข้อมูล valuation")!;
    expect(c.status).toBe("warn");
    expect(c.message).toBe("PTT ddm (2026-10-26): a และอีก 1 ข้อ");
    const ok = assessDataQuality({ ...clean, valuationDates: [{ symbol: "PTT", method: "ddm", date: "2026-10-26", flags: [] }] });
    expect(ok.checks.find((x) => x.area === "วันที่ข้อมูล valuation")!.status).toBe("ok");
    expect(assessDataQuality(clean).checks.some((x) => x.area === "วันที่ข้อมูล valuation")).toBe(false);
  });
});
