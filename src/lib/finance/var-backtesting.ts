/**
 * VaR / ES table and VaR coverage backtests (v3 Phase 4). Reuses the existing historical
 * `historicalVaR` / `expectedShortfall` (fractional-boundary ES) — no second estimator.
 *
 * Conventions: VaR and ES are POSITIVE losses as a fraction of value over ONE observation period
 * (daily prices → 1 day); the sample mean is NOT removed (loss quantile of observed returns).
 * Multi-day figures are √h scalings of the 1-period estimate and are labelled as approximations.
 * Backtests are diagnostics: a failed test is reported, the model is not re-calibrated to pass.
 */
import { MIN_VAR_OBS, expectedShortfall, historicalVaR } from "./risk";

/** Minimum observations: 95% uses the existing MIN_VAR_OBS (100); 99% needs ≥ 250 (≥ 2.5 tail points). */
export const MIN_OBS_BY_CONFIDENCE: Record<string, number> = { "0.95": MIN_VAR_OBS, "0.99": 250 };
/** Below this the 99% estimate rests on very few tail points and is flagged as unreliable. */
export const RELIABLE_OBS_99 = 500;

export interface VarRow {
  confidence: number;
  var: number | null;
  es: number | null;
  observations: number;
  minRequired: number;
  tailObservations: number;
  reliable: boolean;
  horizon: { periods: 1; tenPeriodScaled: { var: number | null; es: number | null; note: string } };
}

export function varTable(rs: number[], levels = [0.95, 0.99]): VarRow[] {
  return levels.map((c) => {
    const min = MIN_OBS_BY_CONFIDENCE[String(c)] ?? Math.ceil(2.5 / (1 - c));
    const v = historicalVaR(rs, c, min);
    const e = expectedShortfall(rs, c, min);
    const tail = rs.length * (1 - c);
    return {
      confidence: c,
      var: v,
      es: e,
      observations: rs.length,
      minRequired: min,
      tailObservations: tail,
      reliable: v != null && (c < 0.99 || rs.length >= RELIABLE_OBS_99),
      horizon: {
        periods: 1,
        tenPeriodScaled: {
          var: v != null ? v * Math.sqrt(10) : null,
          es: e != null ? e * Math.sqrt(10) : null,
          note: "√10 × ค่า 1 งวด — ประมาณการโดยสมมติผลตอบแทนแต่ละงวดอิสระกัน ไม่ใช่การวัดจากข้อมูล 10 วันจริง",
        },
      },
    };
  });
}

/** Upper-tail probability of χ² with 1 degree of freedom: P(X > x) = erfc(√(x/2)). */
export function chi2Sf1(x: number): number {
  if (!(x > 0)) return 1;
  return erfc(Math.sqrt(x / 2));
}

/** erfc via a rational Chebyshev approximation (|ε| < 1.2e-7), ample for p-values. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

const xlogy = (x: number, y: number) => (x === 0 ? 0 : x * Math.log(y));

export interface VarBacktest {
  confidence: number;
  window: number;
  evaluated: number;
  exceptions: number;
  expected: number;
  exceptionRate: number;
  kupiec: { lr: number; pValue: number; reject5pct: boolean };
  christoffersen: { lr: number; pValue: number; reject5pct: boolean } | { unavailable: string };
  conditionalCoverage: { lr: number; pValue: number } | null;
  firstDate?: string;
  note: string;
}

/**
 * Rolling out-of-sample backtest: at each t ≥ window, VaR_t from the previous `window` returns only,
 * exception when the loss on t exceeds VaR_t. Kupiec unconditional coverage (χ²₁); Christoffersen
 * independence (χ²₁) only with ≥ 5 exceptions and both transition types observed.
 */
export function backtestVaR(rs: number[], c: number, window = 250, dates?: string[]): VarBacktest | { unavailable: string } {
  if (rs.length < window + 100) return { unavailable: `ต้องมีข้อมูลอย่างน้อย ${window + 100} งวด (ช่วงประมาณ ${window} + ทดสอบ ≥ 100) — มี ${rs.length}` };
  const hits: number[] = [];
  for (let t = window; t < rs.length; t++) {
    const v = historicalVaR(rs.slice(t - window, t), c, window);
    hits.push(v != null && -rs[t] > v ? 1 : 0);
  }
  const T = hits.length;
  const x = hits.reduce((a, b) => a + b, 0);
  const p = 1 - c;
  const pHat = x / T;
  const lrUc = -2 * (xlogy(T - x, 1 - p) + xlogy(x, p) - xlogy(T - x, 1 - pHat) - xlogy(x, pHat));
  let christ: VarBacktest["christoffersen"];
  let cc: VarBacktest["conditionalCoverage"] = null;
  let n00 = 0;
  let n01 = 0;
  let n10 = 0;
  let n11 = 0;
  for (let i = 1; i < T; i++) {
    if (hits[i - 1] === 0 && hits[i] === 0) n00++;
    else if (hits[i - 1] === 0) n01++;
    else if (hits[i] === 0) n10++;
    else n11++;
  }
  if (x >= 5 && n01 + n00 > 0 && n10 + n11 > 0) {
    const p01 = n01 / (n00 + n01);
    const p11 = n11 / (n10 + n11);
    const p1 = (n01 + n11) / (n00 + n01 + n10 + n11);
    const lrInd = -2 * (xlogy(n00 + n10, 1 - p1) + xlogy(n01 + n11, p1) - xlogy(n00, 1 - p01) - xlogy(n01, p01) - xlogy(n10, 1 - p11) - xlogy(n11, p11));
    christ = { lr: lrInd, pValue: chi2Sf1(lrInd), reject5pct: chi2Sf1(lrInd) < 0.05 };
    // Conditional coverage: LR_uc + LR_ind ~ χ²₂, P(X > x) = exp(−x/2).
    cc = { lr: lrUc + lrInd, pValue: Math.exp(-(lrUc + lrInd) / 2) };
  } else christ = { unavailable: `ต้องมีการทะลุอย่างน้อย 5 ครั้งและมีทั้งกรณีทะลุต่อเนื่อง/ไม่ต่อเนื่อง (มี ${x})` };
  return {
    confidence: c,
    window,
    evaluated: T,
    exceptions: x,
    expected: T * p,
    exceptionRate: pHat,
    kupiec: { lr: lrUc, pValue: chi2Sf1(lrUc), reject5pct: chi2Sf1(lrUc) < 0.05 },
    christoffersen: christ,
    conditionalCoverage: cc,
    firstDate: dates?.[window],
    note: "VaR ย้อนหลังแบบ rolling ใช้เฉพาะข้อมูลก่อนวันที่ทดสอบ · ไม่ผ่านการทดสอบ = แบบจำลองประเมินความเสี่ยงต่ำ/สูงเกินไปในช่วงนี้ (ไม่ปรับแต่งให้ผ่าน)",
  };
}
