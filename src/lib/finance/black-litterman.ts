/**
 * Black–Litterman expected returns (Roadmap Phase 3). Produces μ only; weights come from the
 * existing optimizer (recommend → optimizer.ts QP).
 *
 * Prior (equilibrium excess returns):  Π = δ Σ w_mkt
 * Views:                               P μ_excess = Q + ε,  ε ~ N(0, Ω)
 * Posterior (He & Litterman form, no Ω⁻¹ so a 100%-confident view is allowed):
 *   μ_excess = Π + τΣPᵀ (PτΣPᵀ + Ω)⁻¹ (Q − PΠ)
 *   Σ_post   = Σ + τΣ − τΣPᵀ (PτΣPᵀ + Ω)⁻¹ PτΣ
 * View uncertainty: ω_k = ((1 − c_k) / c_k) · p_k τΣ p_kᵀ for confidence c_k ∈ (0, 1]
 *   (c = 0.5 gives He–Litterman's ω = p τΣ pᵀ; c = 1 forces the view; c → 0 ignores it),
 *   or an explicit variance per view.
 * All returns are annual decimals; the result adds Rf back to excess returns.
 */
import { invert } from "./optimizer";
import type { Matrix } from "./mpt";

export type BlView =
  | { type: "absolute"; symbol: string; return: number; confidence: number; variance?: number }
  | { type: "relative"; long: string[]; short: string[]; return: number; confidence: number; variance?: number };

export interface BlInput {
  symbols: string[];
  cov: Matrix;
  rf: number;
  /** Market (benchmark) weights by symbol — never the user's holdings by default. */
  marketWeights: Record<string, number>;
  /** δ; when omitted it is implied from the market premium: δ = ERP / (w Σ w). */
  riskAversion?: number;
  /** Market equity risk premium, used only to imply δ. */
  marketPremium?: number;
  tau: number;
  views: BlView[];
}

export interface BlResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  riskAversion: number | null;
  riskAversionSource: "given" | "implied";
  tau: number;
  marketWeights: number[];
  /** Total returns (excess + Rf). */
  prior: number[];
  posterior: number[];
  posteriorCov: Matrix | null;
  views: {
    label: string;
    p: number[];
    q: number;
    confidence: number;
    omega: number;
    /** Equilibrium-implied value of the view (PΠ, total-return basis for absolute views). */
    priorValue: number;
    posteriorValue: number;
  }[];
}

const mm = (a: Matrix, b: Matrix) => a.map((r) => b[0].map((_, j) => r.reduce((s, x, k) => s + x * b[k][j], 0)));
const mv = (a: Matrix, v: number[]) => a.map((r) => r.reduce((s, x, k) => s + x * v[k], 0));
const tr = (a: Matrix) => a[0].map((_, j) => a.map((r) => r[j]));
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

export function blackLitterman(x: BlInput): BlResult {
  const n = x.symbols.length;
  const errors: string[] = [];
  const warnings: string[] = [];
  const idx = new Map(x.symbols.map((s, i) => [s.toUpperCase(), i]));
  const fail = (): BlResult => ({
    ok: false,
    errors,
    warnings,
    riskAversion: null,
    riskAversionSource: x.riskAversion != null ? "given" : "implied",
    tau: x.tau,
    marketWeights: [],
    prior: [],
    posterior: [],
    posteriorCov: null,
    views: [],
  });

  // Market weights: every asset in the universe must be given (0 allowed); normalized to 1.
  const given = new Map(Object.entries(x.marketWeights).map(([k, v]) => [k.toUpperCase(), v]));
  const missing = x.symbols.filter((s) => !given.has(s.toUpperCase()));
  if (missing.length) errors.push(`ต้องระบุน้ำหนักตลาด (market weight) ของ ${missing.join(", ")} — ใส่ 0 ได้ถ้าไม่อยู่ในพอร์ตตลาด (ระบบไม่ใช้พอร์ตที่ถืออยู่แทนให้)`);
  const extra = [...given.keys()].filter((k) => !idx.has(k));
  if (extra.length) warnings.push(`น้ำหนักตลาดของ ${extra.join(", ")} ไม่อยู่ในชุดสินทรัพย์ที่คำนวณ — ไม่ใช้`);
  const raw = x.symbols.map((s) => given.get(s.toUpperCase()) ?? 0);
  if (raw.some((w) => !(w >= 0))) errors.push("น้ำหนักตลาดต้องไม่ติดลบ");
  const total = raw.reduce((a, b) => a + b, 0);
  if (!(total > 0)) errors.push("ผลรวมน้ำหนักตลาดต้องมากกว่า 0");
  if (!(x.tau > 0 && x.tau <= 1)) errors.push("τ ต้องอยู่ระหว่าง 0 ถึง 1 (มักใช้ 0.025–0.05)");
  if (errors.length) return fail();
  if (Math.abs(total - 1) > 1e-6) warnings.push(`น้ำหนักตลาดรวม ${(total * 100).toFixed(2)}% — ปรับสัดส่วนให้รวม 100%`);
  const w = raw.map((v) => v / total);

  const S = x.cov;
  const marketVar = dot(w, mv(S, w));
  let delta = x.riskAversion;
  if (delta == null) {
    if (x.marketPremium == null || !(marketVar > 0)) {
      errors.push("ระบุ market risk aversion (δ) หรือ ERP เพื่อคำนวณ δ = ERP / σ²ตลาด");
      return fail();
    }
    delta = x.marketPremium / marketVar;
    warnings.push(`δ คำนวณจาก ERP ${(x.marketPremium * 100).toFixed(2)}% ÷ σ²ตลาด ${(marketVar * 100).toFixed(2)}% = ${delta.toFixed(2)}`);
  }
  if (!(delta > 0)) {
    errors.push("Market risk aversion (δ) ต้องมากกว่า 0");
    return fail();
  }
  const pi = mv(S, w).map((v) => delta! * v);

  // Views → P, Q (excess-return basis), Ω.
  const P: number[][] = [];
  const Q: number[] = [];
  const labels: string[] = [];
  const conf: number[] = [];
  const explicitVar: (number | undefined)[] = [];
  x.views.forEach((v, k) => {
    const row = Array(n).fill(0);
    const bad = (s: string) => !idx.has(s.toUpperCase());
    if (v.type === "absolute") {
      if (bad(v.symbol)) return errors.push(`View ${k + 1}: ไม่มี ${v.symbol} ในชุดสินทรัพย์`);
      row[idx.get(v.symbol.toUpperCase())!] = 1;
      labels.push(`${v.symbol.toUpperCase()} = ${(v.return * 100).toFixed(2)}%`);
      Q.push(v.return - x.rf);
    } else {
      const unknown = [...v.long, ...v.short].filter(bad);
      if (unknown.length) return errors.push(`View ${k + 1}: ไม่มี ${unknown.join(", ")} ในชุดสินทรัพย์`);
      if (!v.long.length || !v.short.length) return errors.push(`View ${k + 1}: relative view ต้องมีทั้งฝั่ง long และ short`);
      const overlap = v.long.filter((s) => v.short.map((t) => t.toUpperCase()).includes(s.toUpperCase()));
      if (overlap.length) return errors.push(`View ${k + 1}: ${overlap.join(", ")} อยู่ทั้งสองฝั่ง`);
      // Equal weights inside each leg: long leg sums to +1, short leg to −1 (rf cancels).
      for (const s of v.long) row[idx.get(s.toUpperCase())!] += 1 / v.long.length;
      for (const s of v.short) row[idx.get(s.toUpperCase())!] -= 1 / v.short.length;
      labels.push(`${v.long.join("+")} − ${v.short.join("+")} = ${(v.return * 100).toFixed(2)}%`);
      Q.push(v.return);
    }
    if (!(v.confidence > 0 && v.confidence <= 1)) errors.push(`View ${k + 1}: ความมั่นใจต้องมากกว่า 0% และไม่เกิน 100%`);
    if (v.variance != null && !(v.variance >= 0)) errors.push(`View ${k + 1}: ความแปรปรวนของ view ต้องไม่ติดลบ`);
    P.push(row);
    conf.push(v.confidence);
    explicitVar.push(v.variance);
  });
  if (errors.length) return fail();

  const tS = S.map((r) => r.map((v) => v * x.tau));
  const priorTotal = pi.map((p) => p + x.rf);
  if (!P.length) {
    warnings.push("ไม่มี view — posterior เท่ากับผลตอบแทนดุลยภาพ (Π)");
    return {
      ok: true,
      errors,
      warnings,
      riskAversion: delta,
      riskAversionSource: x.riskAversion != null ? "given" : "implied",
      tau: x.tau,
      marketWeights: w,
      prior: priorTotal,
      posterior: priorTotal,
      posteriorCov: S.map((r, i) => r.map((v, j) => v + tS[i][j])),
      views: [],
    };
  }

  const tSPt = mm(tS, tr(P)); // n×k
  const PtSPt = mm(P, tSPt); // k×k
  const omega = P.map((_, k) => explicitVar[k] ?? ((1 - conf[k]) / conf[k]) * PtSPt[k][k]);
  const A = PtSPt.map((r, i) => r.map((v, j) => v + (i === j ? omega[i] : 0)));
  const Ainv = invert(A);
  if (!Ainv) {
    errors.push("Views ขัดกันหรือซ้ำกัน (เมทริกซ์ PτΣPᵀ + Ω singular) — ลด view ที่ซ้ำ หรือลดความมั่นใจจาก 100%");
    return fail();
  }
  const gap = Q.map((q, k) => q - dot(P[k], pi));
  const post = pi.map((p, i) => p + dot(tSPt[i], mv(Ainv, gap)));
  const M = tS.map((r, i) => r.map((v, j) => v - dot(tSPt[i], mv(Ainv, tSPt[j]))));
  const postCov = S.map((r, i) => r.map((v, j) => v + M[i][j]));

  const absBasis = (k: number) => (x.views[k].type === "absolute" ? x.rf : 0);
  return {
    ok: true,
    errors,
    warnings,
    riskAversion: delta,
    riskAversionSource: x.riskAversion != null ? "given" : "implied",
    tau: x.tau,
    marketWeights: w,
    prior: priorTotal,
    posterior: post.map((p) => p + x.rf),
    posteriorCov: postCov,
    views: P.map((p, k) => ({
      label: labels[k],
      p,
      q: Q[k] + absBasis(k),
      confidence: conf[k],
      omega: omega[k],
      priorValue: dot(p, pi) + absBasis(k),
      posteriorValue: dot(p, post) + absBasis(k),
    })),
  };
}
