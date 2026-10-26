import { TRADING_DAYS } from "./stats";

const DAY_MS = 86_400_000;

export interface CashFlow {
  date: string; // YYYY-MM-DD
  /** Investor perspective: negative = money invested, positive = money received. */
  amount: number;
}

function days(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / DAY_MS;
}

export type XirrStatus = "ok" | "no_sign_change" | "no_root" | "multiple_roots";

export interface XirrResult {
  /** Annual money-weighted return (ACT/365), or null when not uniquely defined. */
  rate: number | null;
  status: XirrStatus;
  /** NPV at the returned rate (should be ≈ 0). */
  residual: number | null;
  /** All roots found in (−99%, +1000%]. */
  candidates: number[];
  convention: "ACT/365";
}

/**
 * Money-weighted return (XIRR): rate r > −1 solving Σ CF_i / (1 + r)^((t_i − t_0)/365) = 0.
 * Scans (−99%, +1000%] for every sign change, bisects each bracket, and reports
 * `multiple_roots` (rate = null) instead of picking one arbitrarily.
 */
export function xirrDetailed(flows: CashFlow[]): XirrResult {
  const base = { convention: "ACT/365" as const };
  const sorted = [...flows].filter((f) => Number.isFinite(f.amount) && f.amount !== 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.some((f) => f.amount > 0) || !sorted.some((f) => f.amount < 0)) {
    return { ...base, rate: null, status: "no_sign_change", residual: null, candidates: [] };
  }
  const t0 = sorted[0].date;
  const ts = sorted.map((f) => days(t0, f.date) / 365);
  const npv = (r: number) => sorted.reduce((s, f, i) => s + f.amount / (1 + r) ** ts[i], 0);

  // Grid on log(1 + r) so that low and high rates are both covered densely.
  const lo = Math.log(0.01);
  const hi = Math.log(11);
  const steps = 4000;
  const roots: number[] = [];
  let prevR = Math.exp(lo) - 1;
  let prevV = npv(prevR);
  for (let k = 1; k <= steps; k++) {
    const r = Math.exp(lo + ((hi - lo) * k) / steps) - 1;
    const v = npv(r);
    if (prevV === 0) roots.push(prevR);
    else if (prevV * v < 0) {
      let a = prevR;
      let b = r;
      let fa = prevV;
      for (let i = 0; i < 200 && b - a > 1e-14; i++) {
        const m = (a + b) / 2;
        const fm = npv(m);
        if (fa * fm <= 0) b = m;
        else {
          a = m;
          fa = fm;
        }
      }
      roots.push((a + b) / 2);
    }
    prevR = r;
    prevV = v;
  }
  if (roots.length === 0) return { ...base, rate: null, status: "no_root", residual: null, candidates: [] };
  if (roots.length > 1) return { ...base, rate: null, status: "multiple_roots", residual: null, candidates: roots };
  return { ...base, rate: roots[0], status: "ok", residual: npv(roots[0]), candidates: roots };
}

/** Convenience wrapper: the unique XIRR or null. */
export function xirr(flows: CashFlow[]): number | null {
  return xirrDetailed(flows).rate;
}

export interface ValuePoint {
  date: string;
  /** Portfolio market value at end of day (after flows). */
  value: number;
  /** External net flow into the portfolio on this day (deposit / buy funded externally = +). */
  flow: number;
}

/** How external flows are timed within a valuation period. */
export type FlowTiming = "start_of_day" | "end_of_day" | "modified_dietz";

export interface PeriodReturn {
  date: string;
  r: number;
  /** Calendar days since the previous valuation. */
  gapDays: number;
}

/**
 * Time-weighted sub-period returns between consecutive valuations.
 *  - start_of_day:   r = V₁ / (V₀ + CF) − 1          (flow invested before the period's market move)
 *  - end_of_day:     r = (V₁ − CF) / V₀ − 1          (flow arrives after the market move)
 *  - modified_dietz: r = (V₁ − V₀ − CF) / (V₀ + ½CF)  (flow assumed mid-period — an approximation, not exact TWR)
 * Periods whose base is ≤ 0 are skipped and reported.
 */
export function periodReturns(points: ValuePoint[], timing: FlowTiming = "start_of_day"): { returns: PeriodReturn[]; issues: string[] } {
  const returns: PeriodReturn[] = [];
  const issues: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const v0 = points[i - 1].value;
    const v1 = points[i].value;
    const cf = points[i].flow;
    let base: number;
    let r: number;
    if (timing === "end_of_day") {
      base = v0;
      r = (v1 - cf) / v0 - 1;
    } else if (timing === "modified_dietz") {
      base = v0 + 0.5 * cf;
      r = (v1 - v0 - cf) / base;
    } else {
      base = v0 + cf;
      r = v1 / base - 1;
    }
    if (!(base > 0) || !Number.isFinite(r)) {
      issues.push(`${points[i].date}: ฐานมูลค่า ≤ 0 — ข้ามช่วงนี้ในการคำนวณ TWR`);
      continue;
    }
    returns.push({ date: points[i].date, r, gapDays: days(points[i - 1].date, points[i].date) });
  }
  return { returns, issues };
}

/** Start-of-day TWR returns (kept for callers that only need the numbers). */
export function twrDailyReturns(points: ValuePoint[]): { date: string; r: number }[] {
  return periodReturns(points, "start_of_day").returns;
}

/** Geometrically link period returns: Π(1 + r) - 1. */
export function linkReturns(rs: number[]): number {
  return rs.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

/** Annualize a cumulative return earned over `periods` periods of size 1/periodsPerYear. */
export function annualize(cumulative: number, periods: number, periodsPerYear = TRADING_DAYS): number {
  if (periods <= 0) return 0;
  return (1 + cumulative) ** (periodsPerYear / periods) - 1;
}

export interface AnnualizedReturn {
  /** Annualized rate — only when the period is at least one year, else null. */
  annualized: number | null;
  /** (1 + cumulative)^(365/days) − 1; extrapolated when days < 365. */
  equivalent: number | null;
  applicable: boolean;
  periodDays: number;
}

/** Annualize a cumulative return over `periodDays` calendar days (ACT/365). */
export function annualizeReturn(cumulative: number, periodDays: number): AnnualizedReturn {
  if (!(periodDays > 0) || !(1 + cumulative > 0)) return { annualized: null, equivalent: null, applicable: false, periodDays };
  const equivalent = (1 + cumulative) ** (365 / periodDays) - 1;
  const applicable = periodDays >= 365;
  return { annualized: applicable ? equivalent : null, equivalent, applicable, periodDays };
}

export function daysBetween(start: string, end: string): number {
  return Math.round(days(start, end));
}
