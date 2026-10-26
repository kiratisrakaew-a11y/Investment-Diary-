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

/**
 * Money-weighted return (XIRR): the annual rate r that solves
 * Σ CF_i / (1 + r)^((t_i - t_0) / 365) = 0.
 * Solved with Newton-Raphson, falling back to bisection.
 */
export function xirr(flows: CashFlow[], guess = 0.1): number | null {
  if (flows.length < 2) return null;
  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  const hasPos = sorted.some((f) => f.amount > 0);
  const hasNeg = sorted.some((f) => f.amount < 0);
  if (!hasPos || !hasNeg) return null;
  const t0 = sorted[0].date;
  const ts = sorted.map((f) => days(t0, f.date) / 365);

  const npv = (r: number) => sorted.reduce((s, f, i) => s + f.amount / (1 + r) ** ts[i], 0);
  const dnpv = (r: number) =>
    sorted.reduce((s, f, i) => s - (ts[i] * f.amount) / (1 + r) ** (ts[i] + 1), 0);

  let r = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(r);
    const d = dnpv(r);
    if (Math.abs(f) < 1e-9) return r;
    if (d === 0 || !Number.isFinite(d)) break;
    const next = r - f / d;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }

  // Bisection fallback on [-0.9999, 100]
  let lo = -0.9999;
  let hi = 100;
  let flo = npv(lo);
  if (flo * npv(hi) > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-9) return mid;
    if (flo * fm < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

export interface ValuePoint {
  date: string;
  /** Portfolio market value at end of day (after flows). */
  value: number;
  /** External net flow into the portfolio on this day (deposit / buy funded externally = +). */
  flow: number;
}

/**
 * Daily time-weighted return series. The flow on day t is assumed to arrive at
 * the start of the day, so r_t = V_t / (V_{t-1} + F_t) - 1. This removes the
 * effect of the investor's deposits/withdrawals (GIPS-style TWR).
 */
export function twrDailyReturns(points: ValuePoint[]): { date: string; r: number }[] {
  const out: { date: string; r: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const base = points[i - 1].value + points[i].flow;
    if (base > 0) out.push({ date: points[i].date, r: points[i].value / base - 1 });
  }
  return out;
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

/** Annualize a cumulative return over a calendar span. */
export function annualizeByDates(cumulative: number, start: string, end: string): number {
  const years = days(start, end) / 365;
  if (years <= 0) return 0;
  // Do not extrapolate returns for periods shorter than a year.
  if (years < 1) return cumulative;
  return (1 + cumulative) ** (1 / years) - 1;
}
