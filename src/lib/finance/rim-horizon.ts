/**
 * Residual income: comparing explicit horizons (e.g. 5Y vs 10Y) on ONE yearly dataset, plus the
 * sensitivities used by the editor and API. Pure — no I/O.
 *
 * Each horizon h uses the first h forecast years exactly as entered and recomputes the continuing
 * value at year h (RIₕ₊₁ from Bₕ and the terminal ROE). Years that were not entered are never
 * invented: a horizon longer than the dataset is reported as insufficient data.
 */
import { multiStageResidualIncome, type RiForecastYear, type RiTerminal, type RiYear } from "./valuation";

export interface RimInput {
  bookValuePerShare: number;
  ke: number;
  price: number;
  payoutRatio?: number;
  forecast: RiForecastYear[];
  terminal: RiTerminal;
}

export interface RimHorizonRow {
  horizon: number;
  status: "ok" | "insufficient_data" | "invalid";
  value: number | null;
  upside: number | null;
  pvResidualIncome: number | null;
  pvContinuingValue: number | null;
  /** PV(continuing value) ÷ value. */
  terminalShareOfValue: number | null;
  /** PV(continuing value) ÷ (value − B₀): share of the premium over book that comes after year h. */
  terminalShareOfPremium: number | null;
  impliedPBV: number | null;
  /** ROE assumed after year h (explicit terminal ROE, else the ROE of year h). */
  terminalRoe: number | null;
  ke: number;
  years: RiYear[];
  errors: string[];
  warnings: string[];
}

export function rimAtHorizon(i: RimInput, h: number): RimHorizonRow {
  const empty = { value: null, upside: null, pvResidualIncome: null, pvContinuingValue: null, terminalShareOfValue: null, terminalShareOfPremium: null, impliedPBV: null, terminalRoe: null, ke: i.ke, years: [] as RiYear[] };
  if (!(Number.isInteger(h) && h >= 1)) return { horizon: h, status: "invalid", ...empty, errors: ["Horizon ต้องเป็นจำนวนเต็ม ≥ 1"], warnings: [] };
  if (i.forecast.length < h)
    return {
      horizon: h,
      status: "insufficient_data",
      ...empty,
      errors: [`มีประมาณการ ${i.forecast.length} ปี — ไม่พอสำหรับ ${h} ปี (ระบบไม่เติมปีที่ขาดให้)`],
      warnings: [],
    };
  const m = multiStageResidualIncome({ bookValuePerShare: i.bookValuePerShare, ke: i.ke, payoutRatio: i.payoutRatio, forecast: i.forecast.slice(0, h), terminal: i.terminal });
  const last = m.years[m.years.length - 1];
  const terminalRoe = i.terminal.method === "none" ? null : (i.terminal.roe ?? last?.roe ?? null);
  const v = m.value;
  const premium = v != null ? v - i.bookValuePerShare : null;
  return {
    horizon: h,
    status: m.errors.length ? "invalid" : "ok",
    value: v,
    upside: v != null && i.price > 0 ? v / i.price - 1 : null,
    pvResidualIncome: m.errors.length ? null : m.pvResidualIncome,
    pvContinuingValue: m.pvTerminalValue,
    terminalShareOfValue: v ? (m.pvTerminalValue ?? 0) / v : null,
    terminalShareOfPremium: premium ? (m.pvTerminalValue ?? 0) / premium : null,
    impliedPBV: v != null && i.bookValuePerShare > 0 ? v / i.bookValuePerShare : null,
    terminalRoe,
    ke: i.ke,
    years: m.years,
    errors: m.errors,
    warnings: m.warnings,
  };
}

export interface RimHorizonComparison {
  rows: RimHorizonRow[];
  /** Value at the longest valid horizon minus the shortest (null when fewer than two are valid). */
  difference: number | null;
  notes: string[];
}

/** Compare horizons on the same dataset (default 5 and 10 years). */
export function rimHorizonComparison(i: RimInput, horizons: number[] = [5, 10]): RimHorizonComparison {
  const rows = [...new Set(horizons)].sort((a, b) => a - b).map((h) => rimAtHorizon(i, h));
  const ok = rows.filter((r) => r.status === "ok" && r.value != null);
  const notes: string[] = [];
  let difference: number | null = null;
  if (ok.length >= 2) {
    const a = ok[0];
    const b = ok[ok.length - 1];
    difference = b.value! - a.value!;
    // Explain where the gap comes from: the extra explicit years versus the continuing value re-based at the later year.
    const extraPv = (b.pvResidualIncome ?? 0) - (a.pvResidualIncome ?? 0);
    const cvChange = (b.pvContinuingValue ?? 0) - (a.pvContinuingValue ?? 0);
    notes.push(`${b.horizon} ปี − ${a.horizon} ปี = ${difference.toFixed(2)}: RI ปี ${a.horizon + 1}–${b.horizon} เพิ่ม PV ${extraPv.toFixed(2)}, continuing value เปลี่ยน ${cvChange.toFixed(2)}`);
    if (a.terminalRoe != null && b.terminalRoe != null && Math.abs(a.terminalRoe - b.terminalRoe) > 1e-9 && i.terminal.method !== "none" && i.terminal.roe == null)
      notes.push(`ROE หลังจบประมาณการต่างกัน (${(a.terminalRoe * 100).toFixed(1)}% vs ${(b.terminalRoe * 100).toFixed(1)}%) เพราะใช้ ROE ของปีสุดท้ายของแต่ละ horizon — ระบุ terminal ROE เพื่อให้เทียบกันบนฐานเดียว`);
    if (Math.abs(difference) > 0.15 * Math.abs(a.value!)) notes.push("มูลค่าสองช่วงต่างกันเกิน 15% — สมมติฐานระยะยาว (ROE ช่วงท้าย / continuing value) มีผลมาก");
  }
  return { rows, difference, notes };
}

/** Value by persistence factor ω (persistence continuing value), for each horizon. */
export function rimPersistenceSensitivity(i: RimInput, horizons: number[] = [5, 10], omegas = [0, 0.2, 0.4, 0.6, 0.8, 0.9, 1]) {
  const roe = i.terminal.method === "none" ? undefined : i.terminal.roe;
  return {
    omegas,
    rows: horizons.map((h) => ({ horizon: h, values: omegas.map((w) => rimAtHorizon({ ...i, terminal: { method: "persistence", persistence: w, roe } }, h).value) })),
  };
}

/**
 * Two-way grids: Ke × terminal ROE and Ke × long-run growth (perpetuity). Shifts are absolute.
 * The centre cell equals the base value at the chosen horizon.
 */
export function rimSensitivity(i: RimInput, horizon: number, keShifts = [-0.02, -0.01, 0, 0.01, 0.02], roeShifts = [-0.04, -0.02, 0, 0.02, 0.04], gShifts = [-0.01, -0.005, 0, 0.005, 0.01]) {
  const baseRow = rimAtHorizon(i, horizon);
  const baseRoe = baseRow.terminalRoe;
  const kes = keShifts.map((s) => i.ke + s);
  const roeGrid =
    i.terminal.method === "none" || baseRoe == null
      ? null
      : {
          ke: kes,
          roe: roeShifts.map((s) => baseRoe + s),
          grid: kes.map((ke) => roeShifts.map((s) => rimAtHorizon({ ...i, ke, terminal: { ...i.terminal, roe: baseRoe + s } as RiTerminal }, horizon).value)),
        };
  const g0 = i.terminal.method === "perpetuity" ? i.terminal.growth : null;
  const gGrid =
    g0 == null
      ? null
      : {
          ke: kes,
          g: gShifts.map((s) => g0 + s),
          grid: kes.map((ke) => gShifts.map((s) => rimAtHorizon({ ...i, ke, terminal: { ...(i.terminal as Extract<RiTerminal, { method: "perpetuity" }>), growth: g0 + s } }, horizon).value)),
        };
  return { horizon, base: baseRow.value, keRoe: roeGrid, keGrowth: gGrid };
}
