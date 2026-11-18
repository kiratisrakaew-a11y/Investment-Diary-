/** Data readiness for abnormal-trading analysis: every missing input is reported, nothing filled in. */
import { describe, expect, it } from "vitest";
import { MIN_HISTORY_DAYS, abnormalDataQuality } from "./quality";
import { assessDataQuality, marketInputProvenance } from "@/lib/governance";

const good = {
  symbol: "AAA",
  priceDays: 400,
  volumeDays: 400,
  zeroVolumeDays: 0,
  sharesRecorded: true,
};
const market = {
  triSymbol: "SETTRI",
  triDays: 400,
  indexSymbol: "^SET.BK",
  indexDays: 400,
};
const codes = (r: ReturnType<typeof abnormalDataQuality>, i = 0) =>
  r.stocks[i].issues.map((x) => x.code);

describe("abnormalDataQuality", () => {
  it("complete data → ok", () => {
    const r = abnormalDataQuality([good], market);
    expect(r.ok).toBe(true);
    expect(r.market).toEqual([]);
  });
  it("needs 150 trading days (120 obs ending 30 days before)", () =>
    expect(MIN_HISTORY_DAYS).toBe(150));
  it("flags missing volume, missing shares, short history, thin trading", () => {
    expect(
      codes(abnormalDataQuality([{ ...good, volumeDays: 0 }], market)),
    ).toEqual(["NO_VOLUME"]);
    expect(
      codes(abnormalDataQuality([{ ...good, volumeDays: 300 }], market)),
    ).toEqual(["PARTIAL_VOLUME"]);
    expect(
      codes(abnormalDataQuality([{ ...good, sharesRecorded: false }], market)),
    ).toEqual(["NO_SHARES"]);
    expect(
      codes(
        abnormalDataQuality(
          [{ ...good, priceDays: 149, volumeDays: 149 }],
          market,
        ),
      ),
    ).toEqual(["SHORT_HISTORY"]);
    expect(
      codes(
        abnormalDataQuality(
          [{ ...good, priceDays: 150, volumeDays: 150 }],
          market,
        ),
      ),
    ).toEqual([]);
    const thin = abnormalDataQuality([{ ...good, zeroVolumeDays: 41 }], market);
    expect(codes(thin)).toEqual(["THIN_TRADING"]);
    expect(thin.stocks[0].issues[0].message).toMatch(/Dimson/);
    expect(
      codes(abnormalDataQuality([{ ...good, zeroVolumeDays: 40 }], market)),
    ).toEqual([]);
  });
  it("market: no TRI warns; a short price index too", () => {
    const noTri = abnormalDataQuality([good], { ...market, triDays: 0 });
    expect(noTri.ok).toBe(false);
    expect(noTri.market).toHaveLength(1);
    expect(noTri.market[0]).toMatch(/SETTRI/);
    const shortIdx = abnormalDataQuality([good], {
      ...market,
      triDays: 0,
      indexDays: 18,
    });
    expect(shortIdx.market).toHaveLength(2);
    expect(shortIdx.market[1]).toMatch(/18 วัน/);
    expect(
      abnormalDataQuality([good], { ...market, triDays: 20 }).market[0],
    ).toMatch(/SETTRI มีข้อมูล 20 วัน/);
  });
  it("appears as one warn check in assessDataQuality; absent input changes nothing", () => {
    const base = {
      provenance: marketInputProvenance({
        riskFreeRate: 0.025,
        riskFreeSource: "x",
        riskFreeAsOf: "2026-01-01",
        equityRiskPremium: 0.06,
        erpSource: "x",
        erpAsOf: "2026-01-01",
      } as never),
      positions: [],
      reconciliation: { navMatches: true, inferredContributionsThb: 0 },
      ledgerIssues: [],
      benchmark: {
        symbol: "^SET.BK",
        lastDate: "2026-11-17",
        kind: "total_return" as const,
      },
      today: "2026-11-18",
      valuations: [],
      bonds: [],
    };
    const without = assessDataQuality(base);
    expect(
      without.checks.some((c) => c.area === "ข้อมูลตรวจการซื้อขายผิดปกติ"),
    ).toBe(false);
    const bad = assessDataQuality({
      ...base,
      abnormal: abnormalDataQuality(
        [{ ...good, sharesRecorded: false }],
        market,
      ),
    });
    const c = bad.checks.find((x) => x.area === "ข้อมูลตรวจการซื้อขายผิดปกติ")!;
    expect(c.status).toBe("warn");
    expect(c.message).toContain("AAA: ไม่มีจำนวนหุ้น");
    const ok = assessDataQuality({
      ...base,
      abnormal: abnormalDataQuality([good], market),
    });
    expect(
      ok.checks.find((x) => x.area === "ข้อมูลตรวจการซื้อขายผิดปกติ")!.status,
    ).toBe("ok");
  });
});
