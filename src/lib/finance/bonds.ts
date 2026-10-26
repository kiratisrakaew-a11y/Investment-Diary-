/**
 * Fixed-coupon bond analytics: price ↔ yield, accrued interest, duration,
 * convexity. Coupon schedule is generated backwards from maturity; accrual uses
 * Actual/Actual (ICMA), the convention for Thai government bonds' price/yield
 * maths. Prices are per 100 of face value. Rates are decimals.
 */

const DAY = 86_400_000;
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

function addMonths(d: Date, months: number): Date {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return r;
}

export interface BondSpec {
  settlement: string; // YYYY-MM-DD
  maturity: string;
  couponRate: number; // annual, decimal
  frequency: 1 | 2 | 4 | 12;
  redemption?: number; // per 100 face, default 100
}

export interface CashFlow {
  date: string;
  /** Time in coupon periods from settlement. */
  periods: number;
  years: number;
  amount: number;
}

/** Remaining cash flows after settlement and the coupon period containing settlement. */
export function schedule(b: BondSpec) {
  const settle = toDate(b.settlement);
  const mat = toDate(b.maturity);
  if (mat <= settle) throw new Error("วันครบกำหนดต้องอยู่หลังวันชำระราคา");
  const step = 12 / b.frequency;
  const dates: Date[] = [mat];
  let k = 1;
  while (true) {
    const d = addMonths(mat, -step * k);
    dates.unshift(d);
    if (d <= settle) break;
    k++;
  }
  const prevCoupon = dates[0];
  const nextCoupon = dates[1];
  const periodDays = (nextCoupon.getTime() - prevCoupon.getTime()) / DAY;
  const accruedDays = (settle.getTime() - prevCoupon.getTime()) / DAY;
  const fraction = (nextCoupon.getTime() - settle.getTime()) / DAY / periodDays; // w
  const coupon = (b.couponRate * 100) / b.frequency;
  const flows: CashFlow[] = dates.slice(1).map((d, i) => {
    const periods = fraction + i;
    const isLast = i === dates.length - 2;
    return { date: iso(d), periods, years: periods / b.frequency, amount: coupon + (isLast ? (b.redemption ?? 100) : 0) };
  });
  return { flows, prevCoupon: iso(prevCoupon), nextCoupon: iso(nextCoupon), accruedDays, periodDays, coupon, accrued: (coupon * accruedDays) / periodDays };
}

export interface BondAnalytics {
  cleanPrice: number;
  dirtyPrice: number;
  accruedInterest: number;
  ytm: number;
  currentYield: number;
  macaulayDuration: number;
  modifiedDuration: number;
  convexity: number;
  /** Price change per 1bp yield change, per 100 face. */
  dv01: number;
  yearsToMaturity: number;
  nextCoupon: string;
  flows: CashFlow[];
}

function dirtyFromYield(flows: CashFlow[], y: number, f: number): number {
  return flows.reduce((s, cf) => s + cf.amount / (1 + y / f) ** cf.periods, 0);
}

/** Full analytics given a yield to maturity. */
export function analyticsFromYield(b: BondSpec, ytm: number): BondAnalytics {
  const s = schedule(b);
  const f = b.frequency;
  const dirty = dirtyFromYield(s.flows, ytm, f);
  const disc = (cf: CashFlow) => cf.amount / (1 + ytm / f) ** cf.periods;
  const macPeriods = s.flows.reduce((acc, cf) => acc + cf.periods * disc(cf), 0) / dirty;
  const macaulay = macPeriods / f;
  const modified = macaulay / (1 + ytm / f);
  const convPeriods = s.flows.reduce((acc, cf) => acc + cf.periods * (cf.periods + 1) * disc(cf), 0) / (dirty * (1 + ytm / f) ** 2);
  const convexity = convPeriods / f ** 2;
  const clean = dirty - s.accrued;
  return {
    cleanPrice: clean,
    dirtyPrice: dirty,
    accruedInterest: s.accrued,
    ytm,
    currentYield: (b.couponRate * 100) / clean,
    macaulayDuration: macaulay,
    modifiedDuration: modified,
    convexity,
    dv01: modified * dirty * 0.0001,
    yearsToMaturity: (toDate(b.maturity).getTime() - toDate(b.settlement).getTime()) / DAY / 365.25,
    nextCoupon: s.nextCoupon,
    flows: s.flows,
  };
}

/** Yield to maturity from a clean price (per 100), solved by bisection + Newton polish. */
export function yieldFromPrice(b: BondSpec, cleanPrice: number): number {
  const s = schedule(b);
  const target = cleanPrice + s.accrued;
  const f = (y: number) => dirtyFromYield(s.flows, y, b.frequency) - target;
  let lo = -0.5 * b.frequency + 1e-6;
  lo = Math.max(lo, -0.99);
  let hi = 2;
  if (f(lo) * f(hi) > 0) throw new Error("หา yield ไม่ได้จากราคานี้");
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-10) return mid;
    if (f(lo) * fm < 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export function analyticsFromPrice(b: BondSpec, cleanPrice: number): BondAnalytics {
  return analyticsFromYield(b, yieldFromPrice(b, cleanPrice));
}

/** Yield to call: treat the call date as maturity redeemed at the call price. */
export function yieldToCall(b: BondSpec, cleanPrice: number, callDate: string, callPrice: number): number {
  return yieldFromPrice({ ...b, maturity: callDate, redemption: callPrice }, cleanPrice);
}

/** Approximate % price change for a yield shock using duration + convexity. */
export function priceChangeApprox(modifiedDuration: number, convexity: number, dy: number): number {
  return -modifiedDuration * dy + 0.5 * convexity * dy * dy;
}

/** Price–yield curve points for charting. */
export function priceYieldCurve(b: BondSpec, center: number, width = 0.04, steps = 33) {
  const out: { ytm: number; price: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const y = Math.max(0.0001, center - width + (2 * width * i) / (steps - 1));
    out.push({ ytm: y, price: analyticsFromYield(b, y).cleanPrice });
  }
  return out;
}

/** Discount (T-bill) instruments: price from simple yield, ACT/365. */
export function discountBillPrice(face: number, yieldRate: number, days: number): number {
  return face / (1 + (yieldRate * days) / 365);
}

export function discountBillYield(face: number, price: number, days: number): number {
  return (face / price - 1) * (365 / days);
}
