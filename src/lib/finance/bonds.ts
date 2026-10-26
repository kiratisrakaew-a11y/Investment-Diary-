/**
 * Fixed-coupon bond analytics: coupon schedule, price ↔ yield, accrued interest,
 * duration, convexity, call/worst yields, horizon return and spot-curve pricing.
 *
 * Conventions (all explicit in `BondSpec`):
 * - Schedule is built backwards from maturity (or from the penultimate coupon date
 *   for an irregular last period) with an end-of-month rule; a first coupon date
 *   with an issue date gives a short or long first period. Malformed schedules throw.
 * - Discounting uses ICMA quasi-coupon periods: CF / (1 + y/f)^t, t = quasi periods from settlement.
 * - Accrued interest uses the chosen day count (ACT/ACT-ICMA default, ACT/365F, ACT/360, 30/360).
 * - Payment dates may be rolled for weekends (no holiday calendar); accrual uses unadjusted dates.
 * Prices are per 100 of original face value. Rates are decimals.
 */

const DAY = 86_400_000;
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dayDiff = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);

export type DayCount = "ACT/ACT-ICMA" | "ACT/365F" | "ACT/360" | "30/360";
export type BusinessDayConvention = "unadjusted" | "following" | "modified_following";
export type BondErrorCode = "INVALID_DATES" | "MALFORMED_SCHEDULE" | "INVALID_PRICE" | "INVALID_INPUT" | "NO_YIELD";

export class BondError extends Error {
  constructor(
    public code: BondErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BondError";
  }
}

const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const isMonthEnd = (d: Date) => d.getUTCDate() === lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth());

function addMonths(d: Date, months: number, eom = false): Date {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = lastDayOfMonth(r.getUTCFullYear(), r.getUTCMonth());
  r.setUTCDate(eom ? last : Math.min(d.getUTCDate(), last));
  return r;
}

export interface BondSpec {
  settlement: string; // YYYY-MM-DD
  maturity: string;
  couponRate: number; // annual, decimal
  frequency: 1 | 2 | 4 | 12;
  redemption?: number; // per 100 face, default 100
  issueDate?: string;
  /** First coupon date when the first period is irregular (short or long). */
  firstCouponDate?: string;
  /** Last regular coupon date when the final period is irregular. */
  penultimateCouponDate?: string;
  dayCount?: DayCount;
  businessDay?: BusinessDayConvention;
  /** Keep coupon dates on month ends; default true when the anchor date is a month end. */
  endOfMonth?: boolean;
  /** Calendar days before a coupon date during which the bond trades ex-coupon. */
  exCouponDays?: number;
  /** Principal repaid before maturity, per 100 original face, on coupon dates. */
  amortization?: { date: string; amount: number }[];
}

export interface CashFlow {
  /** Scheduled (unadjusted) date used for accrual and discounting. */
  date: string;
  /** Payment date after the business-day convention. */
  payDate: string;
  /** Time in quasi-coupon periods from settlement. */
  periods: number;
  years: number;
  amount: number;
  coupon: number;
  principal: number;
}

/** Day-count fraction between two dates for non-ICMA conventions. */
function yearFraction(a: Date, b: Date, dc: DayCount): number {
  if (dc === "ACT/360") return dayDiff(a, b) / 360;
  if (dc === "30/360") {
    let d1 = a.getUTCDate();
    let d2 = b.getUTCDate();
    if (d1 === 31) d1 = 30;
    if (d2 === 31 && d1 === 30) d2 = 30;
    return (360 * (b.getUTCFullYear() - a.getUTCFullYear()) + 30 * (b.getUTCMonth() - a.getUTCMonth()) + (d2 - d1)) / 360;
  }
  return dayDiff(a, b) / 365;
}

function adjust(d: Date, conv: BusinessDayConvention): Date {
  if (conv === "unadjusted") return d;
  const dow = d.getUTCDay();
  if (dow !== 0 && dow !== 6) return d;
  const fwd = new Date(d.getTime() + (dow === 6 ? 2 : 1) * DAY);
  if (conv === "modified_following" && fwd.getUTCMonth() !== d.getUTCMonth()) return new Date(d.getTime() - (dow === 6 ? 1 : 2) * DAY);
  return fwd;
}

interface Period {
  start: Date;
  end: Date;
  /** Coupon for the full period per 100 outstanding. */
  couponPer100: number;
  outstanding: number;
  principal: number;
}

interface Built {
  periods: Period[];
  /** Period containing settlement (index into periods), its accrued amount and quasi-period fraction helper. */
  current: number;
  accrued: number;
  quasi: (a: Date, b: Date) => number;
  settle: Date;
  exCoupon: boolean;
  firstPeriod: "regular" | "short" | "long";
  lastPeriod: "regular" | "short" | "long";
}

function build(b: BondSpec): Built {
  const f = b.frequency;
  if (![1, 2, 4, 12].includes(f)) throw new BondError("INVALID_INPUT", "ความถี่จ่ายดอกเบี้ยต้องเป็น 1, 2, 4 หรือ 12 ครั้งต่อปี");
  if (!(b.couponRate >= 0) || !Number.isFinite(b.couponRate)) throw new BondError("INVALID_INPUT", "อัตราคูปองต้องไม่ติดลบ (ตราสารดอกเบี้ยลอยตัวยังไม่รองรับ)");
  const settle = toDate(b.settlement);
  const mat = toDate(b.maturity);
  if ([settle, mat].some((d) => Number.isNaN(d.getTime()))) throw new BondError("INVALID_DATES", "รูปแบบวันที่ไม่ถูกต้อง");
  if (mat <= settle) throw new BondError("INVALID_DATES", "วันครบกำหนดต้องอยู่หลังวันชำระราคา");
  const issue = b.issueDate ? toDate(b.issueDate) : null;
  if (issue && issue > settle) throw new BondError("INVALID_DATES", "วันชำระราคาต้องไม่ก่อนวันออกตราสาร");
  const pen = b.penultimateCouponDate ? toDate(b.penultimateCouponDate) : null;
  if (pen && (pen >= mat || (issue && pen <= issue))) throw new BondError("MALFORMED_SCHEDULE", "วันจ่ายคูปองงวดรองสุดท้ายต้องอยู่ระหว่างวันออกตราสารและวันครบกำหนด");
  const first = b.firstCouponDate ? toDate(b.firstCouponDate) : null;
  if (first && (first > (pen ?? mat) || (issue && first <= issue))) throw new BondError("MALFORMED_SCHEDULE", "วันจ่ายคูปองแรกต้องอยู่หลังวันออกตราสารและไม่เกินวันครบกำหนด");

  const step = 12 / f;
  const anchor = pen ?? mat;
  const eom = b.endOfMonth ?? isMonthEnd(anchor);
  const grid = (k: number) => (k === 0 ? anchor : addMonths(anchor, -step * k, eom));
  const dc = b.dayCount ?? "ACT/ACT-ICMA";
  const cpn = (b.couponRate * 100) / f;

  // Quasi-coupon grid covering every date we need (forward of the anchor too, for an irregular last period).
  const earliest = Math.min(settle.getTime(), issue?.getTime() ?? Infinity, first?.getTime() ?? Infinity);
  const q: Date[] = [];
  for (let k = -2; ; k++) {
    const d = grid(k);
    q.unshift(d);
    if (d.getTime() < earliest - 400 * DAY || k > 4000) break;
  }
  q.sort((x, y) => x.getTime() - y.getTime());
  const quasi = (a: Date, c: Date) => {
    if (c <= a) return 0;
    let t = 0;
    for (let i = 0; i + 1 < q.length; i++) {
      const lo = Math.max(a.getTime(), q[i].getTime());
      const hi = Math.min(c.getTime(), q[i + 1].getTime());
      if (hi > lo) t += (hi - lo) / (q[i + 1].getTime() - q[i].getTime());
    }
    return t;
  };

  // Regular payment dates from the first coupon (or the grid) up to the anchor.
  const pay: Date[] = [];
  for (let k = 0; ; k++) {
    const d = grid(k);
    if (first) {
      if (d < first) {
        throw new BondError("MALFORMED_SCHEDULE", `วันจ่ายคูปองแรก ${b.firstCouponDate} ไม่ตรงกับรอบคูปองที่นับย้อนจาก ${pen ? "งวดรองสุดท้าย" : "วันครบกำหนด"} (ทุก ${step} เดือน)`);
      }
      pay.unshift(d);
      if (d.getTime() === first.getTime()) break;
    } else {
      pay.unshift(d);
      if (d <= settle || (issue && d <= issue)) break;
    }
    if (k > 4000) throw new BondError("MALFORMED_SCHEDULE", "ตารางคูปองยาวเกินไป");
  }
  if (pen) pay.push(mat);
  // Start of the first counted period: the issue date (irregular first coupon) or the previous quasi date.
  // Without an explicit first coupon the earliest generated date is that start (accrual from issue if later).
  let firstStart: Date;
  if (first) firstStart = issue ?? addMonths(first, -step, eom);
  else {
    firstStart = pay.shift()!;
    if (issue && issue > firstStart) firstStart = issue;
  }

  const amort = new Map<number, number>();
  for (const a of b.amortization ?? []) {
    const t = toDate(a.date).getTime();
    if (!(a.amount > 0) || !pay.some((d) => d.getTime() === t) || t === mat.getTime()) {
      throw new BondError("MALFORMED_SCHEDULE", `การทยอยคืนเงินต้นวันที่ ${a.date} ต้องเป็นวันจ่ายคูปองก่อนครบกำหนดและจำนวนต้องมากกว่า 0`);
    }
    amort.set(t, (amort.get(t) ?? 0) + a.amount);
  }
  const totalAmort = [...amort.values()].reduce((x, y) => x + y, 0);
  if (totalAmort >= 100 - 1e-9) throw new BondError("MALFORMED_SCHEDULE", `ทยอยคืนเงินต้นรวม ${totalAmort} ≥ 100 — ไม่เหลือเงินต้น ณ วันครบกำหนด`);

  const periods: Period[] = [];
  let outstanding = 100;
  let start = firstStart;
  for (const end of pay) {
    const regular = Math.abs(quasi(start, end) - 1) < 1e-9 && q.some((d) => d.getTime() === start.getTime());
    const couponPer100 = regular ? cpn : dc === "ACT/ACT-ICMA" ? cpn * quasi(start, end) : b.couponRate * 100 * yearFraction(start, end, dc);
    const isMat = end.getTime() === mat.getTime();
    const principal = isMat ? (outstanding * (b.redemption ?? 100)) / 100 : (amort.get(end.getTime()) ?? 0);
    periods.push({ start, end, couponPer100, outstanding, principal });
    if (!isMat) outstanding -= principal;
    start = end;
  }
  const current = periods.findIndex((p) => p.end > settle);
  const cur = periods[current];
  const accruedFull =
    ((dc === "ACT/ACT-ICMA" ? cpn * quasi(cur.start, settle) : b.couponRate * 100 * yearFraction(cur.start, settle, dc)) * cur.outstanding) / 100;
  const exDays = b.exCouponDays ?? 0;
  const exCoupon = exDays > 0 && dayDiff(settle, cur.end) <= exDays && settle < cur.end;
  const fp = periods[0];
  const lp = periods[periods.length - 1];
  const kind = (p: Period) => {
    const x = quasi(p.start, p.end);
    return Math.abs(x - 1) < 1e-9 ? ("regular" as const) : x < 1 ? ("short" as const) : ("long" as const);
  };
  return {
    periods,
    current,
    accrued: exCoupon ? accruedFull - (cur.couponPer100 * cur.outstanding) / 100 : accruedFull,
    quasi,
    settle,
    exCoupon,
    firstPeriod: first ? kind(fp) : "regular",
    lastPeriod: pen ? kind(lp) : "regular",
  };
}

/** Remaining cash flows after settlement and the coupon period containing settlement. */
export function schedule(b: BondSpec) {
  const s = build(b);
  const conv = b.businessDay ?? "unadjusted";
  const flows: CashFlow[] = s.periods.slice(s.current).map((p, i) => {
    const coupon = i === 0 && s.exCoupon ? 0 : (p.couponPer100 * p.outstanding) / 100;
    const periods = s.quasi(s.settle, p.end);
    return {
      date: iso(p.end),
      payDate: iso(adjust(p.end, conv)),
      periods,
      years: periods / b.frequency,
      amount: coupon + p.principal,
      coupon,
      principal: p.principal,
    };
  });
  const cur = s.periods[s.current];
  return {
    flows,
    prevCoupon: iso(cur.start),
    nextCoupon: iso(cur.end),
    accruedDays: dayDiff(cur.start, s.settle),
    periodDays: dayDiff(cur.start, cur.end),
    coupon: (b.couponRate * 100) / b.frequency,
    accrued: s.accrued,
    exCoupon: s.exCoupon,
    firstPeriod: s.firstPeriod,
    lastPeriod: s.lastPeriod,
    dayCount: b.dayCount ?? "ACT/ACT-ICMA",
  };
}

export interface YieldScenario {
  shiftBp: number;
  ytm: number;
  cleanPrice: number;
  /** Exact % change of the dirty price. */
  change: number;
  /** Duration + convexity approximation of the same change. */
  approx: number;
}

export interface BondAnalytics {
  cleanPrice: number;
  dirtyPrice: number;
  accruedInterest: number;
  ytm: number;
  /** Annual coupon ÷ clean price — not a yield to maturity. */
  currentYield: number;
  macaulayDuration: number;
  modifiedDuration: number;
  convexity: number;
  /** Bump-and-reprice (±1bp) duration and convexity, for reconciliation. */
  effectiveDuration: number;
  effectiveConvexity: number;
  /** Price change per 1bp yield change, per 100 face. */
  dv01: number;
  yearsToMaturity: number;
  nextCoupon: string;
  flows: CashFlow[];
  scenarios: YieldScenario[];
  exCoupon: boolean;
  firstPeriod: "regular" | "short" | "long";
  lastPeriod: "regular" | "short" | "long";
  dayCount: DayCount;
}

function dirtyFromYield(flows: { periods: number; amount: number }[], y: number, f: number): number {
  if (!(1 + y / f > 0)) return NaN;
  return flows.reduce((s, cf) => s + cf.amount / (1 + y / f) ** cf.periods, 0);
}

/** Full analytics given a yield to maturity. */
export function analyticsFromYield(b: BondSpec, ytm: number): BondAnalytics {
  const s = schedule(b);
  const f = b.frequency;
  if (!(1 + ytm / f > 0)) throw new BondError("INVALID_INPUT", "Yield ต่ำเกินไป (1 + y/f ต้องมากกว่า 0)");
  const dirty = dirtyFromYield(s.flows, ytm, f);
  const disc = (cf: CashFlow) => cf.amount / (1 + ytm / f) ** cf.periods;
  const macPeriods = s.flows.reduce((acc, cf) => acc + cf.periods * disc(cf), 0) / dirty;
  const macaulay = macPeriods / f;
  const modified = macaulay / (1 + ytm / f);
  const convPeriods = s.flows.reduce((acc, cf) => acc + cf.periods * (cf.periods + 1) * disc(cf), 0) / (dirty * (1 + ytm / f) ** 2);
  const convexity = convPeriods / f ** 2;
  const clean = dirty - s.accrued;
  const h = 0.0001;
  const up = dirtyFromYield(s.flows, ytm + h, f);
  const dn = dirtyFromYield(s.flows, ytm - h, f);
  const scenarios = [-100, -50, -25, 25, 50, 100].map((bp) => {
    const y = ytm + bp / 10000;
    const d = dirtyFromYield(s.flows, y, f);
    const dy = bp / 10000;
    return { shiftBp: bp, ytm: y, cleanPrice: d - s.accrued, change: d / dirty - 1, approx: -modified * dy + 0.5 * convexity * dy * dy };
  });
  return {
    cleanPrice: clean,
    dirtyPrice: dirty,
    accruedInterest: s.accrued,
    ytm,
    currentYield: (b.couponRate * 100) / clean,
    macaulayDuration: macaulay,
    modifiedDuration: modified,
    convexity,
    effectiveDuration: (dn - up) / (2 * dirty * h),
    effectiveConvexity: (dn + up - 2 * dirty) / (dirty * h * h),
    dv01: modified * dirty * 0.0001,
    yearsToMaturity: (toDate(b.maturity).getTime() - toDate(b.settlement).getTime()) / DAY / 365.25,
    nextCoupon: s.nextCoupon,
    flows: s.flows,
    scenarios,
    exCoupon: s.exCoupon,
    firstPeriod: s.firstPeriod,
    lastPeriod: s.lastPeriod,
    dayCount: s.dayCount,
  };
}

/** Yield that equates the dirty price of a set of flows; throws NO_YIELD when no root is bracketed. */
function yieldForFlows(flows: { periods: number; amount: number }[], dirty: number, f: number): number {
  const g = (y: number) => dirtyFromYield(flows, y, f) - dirty;
  let lo = Math.max(-0.99 * f, -0.99);
  let hi = 5;
  if (!(g(lo) * g(hi) <= 0)) throw new BondError("NO_YIELD", "หา yield ไม่ได้จากราคานี้ (อยู่นอกช่วง −99% ถึง 500%)");
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const gm = g(mid);
    if (gm === 0) return mid;
    if (g(lo) * gm < 0) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-15) break;
  }
  return (lo + hi) / 2;
}

function checkPrice(cleanPrice: number) {
  if (!Number.isFinite(cleanPrice) || cleanPrice <= 0) throw new BondError("INVALID_PRICE", "ราคาต้องมากกว่า 0");
}

/** Yield to maturity from a clean price (per 100). */
export function yieldFromPrice(b: BondSpec, cleanPrice: number): number {
  checkPrice(cleanPrice);
  const s = schedule(b);
  return yieldForFlows(s.flows, cleanPrice + s.accrued, b.frequency);
}

export function analyticsFromPrice(b: BondSpec, cleanPrice: number): BondAnalytics {
  return analyticsFromYield(b, yieldFromPrice(b, cleanPrice));
}

/** Cash flows if the bond is called: scheduled coupons up to the call date, then call price + accrued coupon. */
export function callFlows(b: BondSpec, callDate: string, callPrice: number) {
  const s = build(b);
  const call = toDate(callDate);
  if (!(call > s.settle) || call >= toDate(b.maturity)) throw new BondError("INVALID_DATES", "วันไถ่ถอนก่อนกำหนดต้องอยู่หลังวันชำระราคาและก่อนวันครบกำหนด");
  const dc = b.dayCount ?? "ACT/ACT-ICMA";
  const cpn = (b.couponRate * 100) / b.frequency;
  const out: { date: string; periods: number; amount: number }[] = [];
  for (const [i, p] of s.periods.slice(s.current).entries()) {
    const coupon = i === 0 && s.exCoupon ? 0 : (p.couponPer100 * p.outstanding) / 100;
    if (p.end < call) {
      out.push({ date: iso(p.end), periods: s.quasi(s.settle, p.end), amount: coupon + p.principal });
      continue;
    }
    const partial =
      p.end.getTime() === call.getTime()
        ? coupon
        : ((dc === "ACT/ACT-ICMA" ? cpn * s.quasi(p.start, call) : b.couponRate * 100 * yearFraction(p.start, call, dc)) * p.outstanding) / 100;
    out.push({ date: callDate, periods: s.quasi(s.settle, call), amount: partial + (callPrice * p.outstanding) / 100 });
    break;
  }
  return { flows: out, accrued: s.accrued };
}

/** Yield to call using the bond's actual coupon schedule up to the call date. */
export function yieldToCall(b: BondSpec, cleanPrice: number, callDate: string, callPrice: number): number {
  checkPrice(cleanPrice);
  const c = callFlows(b, callDate, callPrice);
  return yieldForFlows(c.flows, cleanPrice + c.accrued, b.frequency);
}

export interface CallOption {
  date: string;
  price: number;
}

/** Yield to worst: the lowest of YTM and the yield to every call date. */
export function yieldToWorst(b: BondSpec, cleanPrice: number, calls: CallOption[]) {
  const candidates = [
    { type: "maturity" as const, date: b.maturity, price: b.redemption ?? 100, yield: yieldFromPrice(b, cleanPrice) },
    ...calls
      .filter((c) => c.date > b.settlement && c.date < b.maturity)
      .map((c) => ({ type: "call" as const, date: c.date, price: c.price, yield: yieldToCall(b, cleanPrice, c.date, c.price) })),
  ];
  const worst = candidates.reduce((a, c) => (c.yield < a.yield ? c : a));
  return { yield: worst.yield, worst, candidates };
}

/**
 * Realized return if bought now at `cleanPrice` and held to `horizonDate`: coupons are reinvested at
 * `reinvestRate` (compounded at the coupon frequency) and the bond is sold at `exitYield` (default: today's YTM).
 */
export function horizonReturn(b: BondSpec, cleanPrice: number, opts: { horizonDate: string; reinvestRate: number; exitYield?: number }) {
  const s = build(b);
  const sch = schedule(b);
  const f = b.frequency;
  const horizon = toDate(opts.horizonDate);
  if (!(horizon > s.settle) || horizon > toDate(b.maturity)) throw new BondError("INVALID_DATES", "วันที่ขาย/ประเมินผลต้องอยู่หลังวันชำระราคาและไม่เกินวันครบกำหนด");
  const ytm = yieldFromPrice(b, cleanPrice);
  const tH = s.quasi(s.settle, horizon);
  const received = sch.flows.filter((cf) => cf.date <= opts.horizonDate);
  const reinvested = received.reduce((acc, cf) => acc + cf.amount * (1 + opts.reinvestRate / f) ** (tH - cf.periods), 0);
  const exitYield = opts.exitYield ?? ytm;
  const sale = opts.horizonDate < b.maturity ? analyticsFromYield({ ...b, settlement: opts.horizonDate }, exitYield).dirtyPrice : 0;
  const initial = cleanPrice + sch.accrued;
  const fv = reinvested + sale;
  return {
    initialDirty: initial,
    futureValue: fv,
    couponsAndReinvestment: reinvested,
    salePrice: sale,
    exitYield,
    totalReturn: fv / initial - 1,
    /** Bond-equivalent annual rate (compounded at the coupon frequency), comparable with YTM. */
    annualizedReturn: f * ((fv / initial) ** (1 / tH) - 1),
  };
}

// ------------------------------------------------------------------ spot curve

export interface CurvePoint {
  years: number;
  /** Zero rate, annually compounded, decimal. */
  rate: number;
}

function zeroRate(curve: CurvePoint[], t: number): number {
  const c = [...curve].sort((a, b) => a.years - b.years);
  if (!c.length) throw new BondError("INVALID_INPUT", "ต้องมี zero curve อย่างน้อย 1 จุด");
  if (t <= c[0].years) return c[0].rate;
  for (let i = 0; i + 1 < c.length; i++) {
    if (t <= c[i + 1].years) return c[i].rate + ((c[i + 1].rate - c[i].rate) * (t - c[i].years)) / (c[i + 1].years - c[i].years);
  }
  return c[c.length - 1].rate;
}

/** Price from a zero curve (linear interpolation, flat extrapolation) plus a constant spread: Σ CF / (1 + z(t) + s)^t. */
export function priceFromCurve(b: BondSpec, curve: CurvePoint[], spread = 0) {
  const s = schedule(b);
  const dirty = s.flows.reduce((acc, cf) => acc + cf.amount / (1 + zeroRate(curve, cf.years) + spread) ** cf.years, 0);
  return { dirtyPrice: dirty, cleanPrice: dirty - s.accrued, accruedInterest: s.accrued };
}

/** Z-spread: the constant spread over the zero curve that reproduces the market clean price. */
export function zSpread(b: BondSpec, cleanPrice: number, curve: CurvePoint[]): number {
  checkPrice(cleanPrice);
  const g = (x: number) => priceFromCurve(b, curve, x).cleanPrice - cleanPrice;
  let lo = -0.5;
  let hi = 2;
  if (!(g(lo) * g(hi) <= 0)) throw new BondError("NO_YIELD", "หา Z-spread ไม่ได้จากราคานี้");
  for (let i = 0; i < 300 && hi - lo > 1e-15; i++) {
    const m = (lo + hi) / 2;
    if (g(lo) * g(m) <= 0) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}

/** Key-rate durations: ±1bp bump of each curve node (triangular influence via linear interpolation). */
export function keyRateDurations(b: BondSpec, curve: CurvePoint[], spread = 0) {
  const p0 = priceFromCurve(b, curve, spread).dirtyPrice;
  const h = 0.0001;
  return curve.map((node, i) => {
    const bump = (d: number) => curve.map((c, j) => (j === i ? { ...c, rate: c.rate + d } : c));
    const up = priceFromCurve(b, bump(h), spread).dirtyPrice;
    const dn = priceFromCurve(b, bump(-h), spread).dirtyPrice;
    return { years: node.years, duration: (dn - up) / (2 * p0 * h) };
  });
}

/** Bond spec for a portfolio bond asset; reports which conventions had to be assumed. */
export function specFromBondAsset(
  a: { couponRate: number | null; maturityDate: string | null; couponFrequency?: number | null; dayCount?: string | null },
  settlement: string,
): { spec: BondSpec; assumed: string[] } {
  const assumed: string[] = [];
  const freq = a.couponFrequency;
  const frequency = freq === 1 || freq === 2 || freq === 4 || freq === 12 ? freq : (assumed.push("จ่ายดอกเบี้ยทุก 6 เดือน"), 2);
  const dcs: DayCount[] = ["ACT/ACT-ICMA", "ACT/365F", "ACT/360", "30/360"];
  const dayCount = dcs.includes(a.dayCount as DayCount) ? (a.dayCount as DayCount) : (assumed.push("day count ACT/ACT-ICMA"), "ACT/ACT-ICMA" as const);
  return { spec: { settlement, maturity: a.maturityDate ?? "", couponRate: (a.couponRate ?? 0) / 100, frequency, dayCount }, assumed };
}

/** Approximate % price change for a yield shock using duration + convexity. */
export function priceChangeApprox(modifiedDuration: number, convexity: number, dy: number): number {
  return -modifiedDuration * dy + 0.5 * convexity * dy * dy;
}

/** Price–yield curve points for charting (negative yields allowed while 1 + y/f > 0). */
export function priceYieldCurve(b: BondSpec, center: number, width = 0.04, steps = 33) {
  const out: { ytm: number; price: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const y = center - width + (2 * width * i) / (steps - 1);
    if (1 + y / b.frequency <= 0.01) continue;
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
