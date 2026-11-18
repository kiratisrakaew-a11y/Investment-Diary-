/** Abnormal volume (mean-adjusted, Campbell & Wasley): planted z, zero volume, missing shares, share changes. */
import { describe, expect, it } from "vitest";
import { CW_CONSTANT, eventVolumeZ, levelOf, rollingVolumeZ, volumeSeries, zeroVolumeShare, type VolumeDay } from "./volume";

const dates = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, 0, 2) + i * 86_400_000).toISOString().slice(0, 10));
// Deterministic volume around 1e6 shares (not market data).
const base = (n: number) => {
  let s = 3;
  return Array.from({ length: n }, () => Math.round(1_000_000 * (1 + ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.6)));
};

describe("volumeSeries", () => {
  const ds = dates(5);
  const days: VolumeDay[] = ds.map((d, i) => ({ date: d, volume: [100, 0, null, 300, 400][i] }));
  it("turnover with shares on every day; V = ln(turnover + c); zero volume stays finite; null skipped", () => {
    const s = volumeSeries(days, [{ effectiveDate: ds[0], shares: 1000 }]);
    expect(s.basis).toBe("turnover");
    expect(s.dates).toEqual([ds[0], ds[1], ds[3], ds[4]]);
    expect(s.turnover).toEqual([0.1, 0, 0.3, 0.4]);
    expect(s.v[1]).toBeCloseTo(Math.log(CW_CONSTANT), 12);
    expect(s.v[0]).toBeCloseTo(Math.log(0.1 + CW_CONSTANT), 12);
    expect(s.warnings.join()).toMatch(/1 วันไม่มีข้อมูล volume/);
  });
  it("share count as of each day (capital increase mid-series)", () => {
    const s = volumeSeries(days, [{ effectiveDate: ds[0], shares: 1000 }, { effectiveDate: ds[3], shares: 2000 }]);
    expect(s.turnover).toEqual([0.1, 0, 0.15, 0.2]);
  });
  it("no / partial share data → raw volume with the reason (never guessed)", () => {
    const none = volumeSeries(days, []);
    expect(none.basis).toBe("raw_volume");
    expect(none.v[0]).toBeCloseTo(Math.log(101), 12);
    expect(none.turnover.every((t) => t === null)).toBe(true);
    expect(none.warnings.join()).toMatch(/ยังไม่มีจำนวนหุ้น/);
    const partial = volumeSeries(days, [{ effectiveDate: ds[3], shares: 1000 }]);
    expect(partial.basis).toBe("raw_volume");
    expect(partial.warnings.join()).toMatch(/ไม่ครอบคลุมทุกวัน \(2\/4\)/);
  });
});

describe("rollingVolumeZ", () => {
  const n = 300;
  const ds = dates(n);
  const vol = base(n);
  const t = 290;
  vol[t] = vol[t] * 20; // planted spike
  const s = volumeSeries(ds.map((d, i) => ({ date: d, volume: vol[i] })), [{ effectiveDate: ds[0], shares: 50_000_000 }]);
  const z = rollingVolumeZ(s, { from: ds[250] });
  it("z equals (V − mean) / sd of the trailing window [t−250, t−30]", () => {
    const row = z.find((r) => r.date === ds[t])!;
    const win = s.v.slice(t - 250, t - 30 + 1);
    const m = win.reduce((a, b) => a + b, 0) / win.length;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / (win.length - 1));
    expect(row.n).toBe(221);
    expect(row.mean!).toBeCloseTo(m, 12);
    expect(row.sd!).toBeCloseTo(sd, 12);
    expect(row.z!).toBeCloseTo((s.v[t] - m) / sd, 10);
    expect(row.level).toBe("ผิดปกติ");
  });
  it("ordinary days are not flagged; early days lack data and say so", () => {
    expect(z.filter((r) => r.date !== ds[t] && r.level !== "ปกติ").length).toBeLessThanOrEqual(2);
    const early = rollingVolumeZ(s, { to: ds[100] });
    expect(early.every((r) => r.z === null && /ต้องมีอย่างน้อย 120/.test(r.reason ?? ""))).toBe(true);
    expect(JSON.stringify(z)).not.toMatch(/NaN|Infinity/);
  });
  it("thresholds are adjustable", () => {
    expect(levelOf(2.5)).toBe("น่าสังเกต");
    expect(levelOf(3.5)).toBe("ผิดปกติ");
    expect(levelOf(2.5, { notable: 3, abnormal: 4 })).toBe("ปกติ");
    expect(levelOf(null)).toBe("ปกติ");
  });
  it("constant volume → no z, with the reason", () => {
    const flat = volumeSeries(ds.map((d) => ({ date: d, volume: 500 })), []);
    const r = rollingVolumeZ(flat, { from: ds[280] });
    expect(r.every((x) => x.z === null && /ไม่เปลี่ยน/.test(x.reason ?? ""))).toBe(true);
  });
});

describe("zero volume and event windows", () => {
  const n = 300;
  const ds = dates(n);
  const vol = base(n).map((v, i) => (i % 8 === 0 ? 0 : v)); // 12.5% no-trade days
  const s = volumeSeries(ds.map((d, i) => ({ date: d, volume: vol[i] })), [{ effectiveDate: ds[0], shares: 50_000_000 }]);
  it("zero-volume share > 10% → thin trading", () => {
    const zv = zeroVolumeShare(s);
    expect(zv.zeroDays).toBe(38);
    expect(zv.thin).toBe(true);
  });
  it("event-window z uses the window fixed to the event day", () => {
    const r = eventVolumeZ(s, ds[280]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.n).toBe(221);
    expect(r.days.map((d) => d.rel)).toEqual(Array.from({ length: 21 }, (_, i) => i - 10));
    expect(r.estimation).toEqual({ from: ds[30], to: ds[250] });
    expect(eventVolumeZ(s, ds[100]).ok).toBe(false);
  });
});
