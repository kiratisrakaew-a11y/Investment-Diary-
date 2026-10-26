/**
 * Turns optimizer inputs + the investor's preferences into a concrete weight
 * recommendation and trade list. Shared by the interactive optimizer page,
 * the AI advisor and the MCP / REST tools so every surface gives the same answer.
 * Infeasible constraints or targets return { ok: false, issue } — never weights that break them.
 */
import { covarianceDiagnostics, portfolioStats, type CovarianceDiagnostics, type Matrix, type PortfolioPoint } from "./mpt";
import {
  OptimizerError,
  analyticFrontier,
  checkWeights,
  completePortfolio,
  constrainedFrontier,
  targetReturnPortfolio,
  targetRiskPortfolio,
  utilityPortfolio,
  validateBounds,
  type Bounds,
  type OptimizedPoint,
  type OptimizerIssue,
  type SolverDiagnostics,
} from "./optimizer";

export type Objective = "max_sharpe" | "min_variance" | "target_return" | "target_risk" | "utility";

export interface RecommendInput {
  symbols: string[];
  mu: number[];
  cov: Matrix;
  rf: number;
  bounds: Bounds;
  objective: Objective;
  /** Risk aversion A in U = E[R] − ½Aσ² (typical 2–10). */
  riskAversion: number;
  targetReturn?: number;
  targetRisk?: number;
  /** Current market value (THB) per symbol, for the trade list. */
  currentValues?: number[];
  /** Total wealth to allocate across risky assets + risk-free (defaults to Σ current values). */
  totalWealth?: number;
  /** Mix the risky portfolio with the risk-free asset along the CAL (complete portfolio). */
  useRiskFree: boolean;
}

export interface RecommendResult {
  ok: true;
  objective: Objective;
  /** Risky portfolio (weights sum to 1 within the risky sleeve). */
  risky: PortfolioPoint;
  /** Fraction of wealth in the risky portfolio (1 when useRiskFree = false). */
  riskyShare: number;
  riskFreeShare: number;
  final: { expectedReturn: number; volatility: number; sharpe: number | null };
  allocations: { symbol: string; weight: number; currentWeight: number; targetValue: number; currentValue: number; trade: number }[];
  current: PortfolioPoint | null;
  gmv: PortfolioPoint;
  tangency: PortfolioPoint | null;
  unconstrained: ReturnType<typeof analyticFrontier>;
  bullet: { volatility: number; expectedReturn: number; efficient: boolean }[];
  solver: SolverDiagnostics;
  constraints: { n: number; min: number; max: number; longOnly: boolean; riskFree: boolean };
  covariance: Pick<CovarianceDiagnostics, "minEigenvalue" | "maxEigenvalue" | "conditionNumber" | "psd">;
  warnings: string[];
}

export type RecommendOutcome = RecommendResult | { ok: false; issue: OptimizerIssue; warnings: string[] };

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function recommend(input: RecommendInput): RecommendOutcome {
  const { rf, bounds, mu } = input;
  const warnings: string[] = [];
  const boundIssue = validateBounds(mu.length, bounds);
  if (boundIssue) return { ok: false, issue: boundIssue, warnings };
  if (!mu.every(Number.isFinite) || !input.cov.every((r) => r.every(Number.isFinite))) {
    return { ok: false, issue: { code: "INVALID_INPUT", message: "ผลตอบแทนคาดหวังหรือ covariance มีค่าที่ไม่ใช่ตัวเลข" }, warnings };
  }
  const diag = covarianceDiagnostics(input.cov);
  warnings.push(...diag.warnings);
  const cov = diag.repaired;

  try {
    const frontier = constrainedFrontier(mu, cov, rf, bounds, 30);
    const unconstrained = analyticFrontier(mu, cov, rf, 80);
    const tangency = frontier.tangency;

    let risky: OptimizedPoint;
    let riskyShare = 1;

    if (input.useRiskFree) {
      // Two-fund separation: the risky sleeve is the tangency portfolio; the objective sets the mix on the CAL.
      if (!tangency) throw new OptimizerError({ code: "NO_EXCESS_RETURN", message: "ไม่มีพอร์ตเสี่ยงที่ผลตอบแทนสูงกว่า Rf — ใช้สินทรัพย์ปลอดความเสี่ยงทั้งหมด", suggestion: "ปิดตัวเลือกสินทรัพย์ปลอดความเสี่ยงหรือทบทวนผลตอบแทนคาดหวัง" });
      risky = tangency;
      const excess = tangency.expectedReturn - rf;
      let y: number;
      switch (input.objective) {
        case "min_variance":
          y = 0;
          warnings.push("เมื่อรวมสินทรัพย์ปลอดความเสี่ยง พอร์ตความเสี่ยงต่ำสุดคือถือสินทรัพย์ปลอดความเสี่ยงทั้งหมด");
          break;
        case "target_return": {
          const t = input.targetReturn ?? tangency.expectedReturn;
          y = (t - rf) / excess;
          warnings.push(`ผลตอบแทนเป้าหมายบนเส้น CAL: y = (เป้า − Rf) ÷ (E[R_T] − Rf) = ${pct(y)}`);
          break;
        }
        case "target_risk": {
          const s = input.targetRisk ?? tangency.volatility;
          y = s / tangency.volatility;
          warnings.push(`ความเสี่ยงเป้าหมายบนเส้น CAL: y = σ เป้า ÷ σ_T = ${pct(y)}`);
          break;
        }
        default:
          y = completePortfolio(tangency, rf, input.riskAversion).riskyShare;
      }
      if (y > 1 + 1e-12) warnings.push(`ต้องลงทุนในสินทรัพย์เสี่ยง ${pct(y)} ของเงินทุน (กู้ยืมเพิ่ม) — จำกัดที่ 100% เพราะไม่ใช้ margin ผลลัพธ์จึงไม่ถึงเป้า`);
      if (y < -1e-12) warnings.push(`y = ${pct(y)} (ขายชอร์ตพอร์ตเสี่ยง) — จำกัดที่ 0%`);
      riskyShare = Math.min(Math.max(y, 0), 1);
    } else {
      switch (input.objective) {
        case "min_variance":
          risky = frontier.gmv;
          break;
        case "target_return":
          risky = targetReturnPortfolio(mu, cov, rf, input.targetReturn ?? frontier.gmv.expectedReturn, bounds);
          break;
        case "target_risk": {
          const p = targetRiskPortfolio(mu, cov, rf, input.targetRisk ?? frontier.gmv.volatility, bounds);
          if (!p.binding) warnings.push(`ความเสี่ยงเป้าหมายสูงกว่าพอร์ตผลตอบแทนสูงสุด (σ ${pct(p.volatility)}) — ข้อจำกัดความเสี่ยงไม่มีผล`);
          risky = p;
          break;
        }
        case "utility":
          risky = utilityPortfolio(mu, cov, rf, Math.max(input.riskAversion, 0.1), bounds);
          break;
        default:
          if (!tangency) {
            throw new OptimizerError({ code: "NO_EXCESS_RETURN", message: `ไม่มีพอร์ตที่ผลตอบแทนคาดหวังสูงกว่า Rf (${pct(rf)}) — ไม่มี tangency portfolio`, suggestion: "เลือก minimum variance หรือทบทวนผลตอบแทนคาดหวัง" });
          }
          risky = tangency;
      }
    }

    // Final constraint check before anything is shown or saved.
    const chk = checkWeights(risky.weights, bounds);
    if (chk.sumError > 1e-8 || chk.maxBoundViolation > 1e-8 || risky.solver.status !== "optimal") {
      return {
        ok: false,
        issue: { code: "INVALID_INPUT", message: `Solver ไม่ลู่เข้า (สถานะ ${risky.solver.status}, Σw−1 = ${chk.sumError.toExponential(1)}, เกินขอบเขต ${chk.maxBoundViolation.toExponential(1)})`, suggestion: "ลองตัดสินทรัพย์ที่ซ้ำกันหรือใช้ covariance แบบ shrinkage" },
        warnings,
      };
    }
    if (risky.solver.regularized) warnings.push("Solver เติม ridge เล็กน้อยเพราะ covariance singular — น้ำหนักระหว่างสินทรัพย์ที่ซ้ำกันไม่ได้มีคำตอบเดียว");
    if (tangency && tangency.expectedReturn <= rf) warnings.push("ผลตอบแทนคาดหวังของสินทรัพย์เสี่ยงไม่สูงกว่า Rf — ตรวจสอบสมมติฐานผลตอบแทน");

    const er = rf + riskyShare * (risky.expectedReturn - rf);
    const vol = riskyShare * risky.volatility;
    const cur = input.currentValues;
    const curTotal = cur ? cur.reduce((a, b) => a + b, 0) : 0;
    const wealth = input.totalWealth ?? curTotal;
    const current = cur && curTotal > 0 ? portfolioStats(cur.map((v) => v / curTotal), mu, cov, rf) : null;
    const allocations = input.symbols.map((symbol, i) => {
      const weight = risky.weights[i] * riskyShare;
      const currentValue = cur?.[i] ?? 0;
      const targetValue = weight * wealth;
      return { symbol, weight, currentWeight: wealth > 0 ? currentValue / wealth : 0, targetValue, currentValue, trade: targetValue - currentValue };
    });

    return {
      ok: true,
      objective: input.objective,
      risky,
      riskyShare,
      riskFreeShare: 1 - riskyShare,
      final: { expectedReturn: er, volatility: vol, sharpe: vol > 0 ? (er - rf) / vol : null },
      allocations,
      current,
      gmv: frontier.gmv,
      tangency,
      unconstrained,
      bullet: frontier.curve.map(({ volatility, expectedReturn, efficient }) => ({ volatility, expectedReturn, efficient })),
      solver: risky.solver,
      constraints: { n: mu.length, min: bounds.min, max: bounds.max, longOnly: bounds.min >= 0, riskFree: input.useRiskFree },
      covariance: { minEigenvalue: diag.minEigenvalue, maxEigenvalue: diag.maxEigenvalue, conditionNumber: diag.conditionNumber, psd: diag.psd },
      warnings,
    };
  } catch (e) {
    if (e instanceof OptimizerError) return { ok: false, issue: e.issue, warnings };
    throw e;
  }
}
