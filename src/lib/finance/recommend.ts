/**
 * Turns optimizer inputs + the investor's preferences into a concrete weight
 * recommendation and trade list. Shared by the interactive optimizer page,
 * the AI advisor and the MCP / REST tools so every surface gives the same answer.
 * Infeasible constraints or targets return { ok: false, issue } — never weights that break them.
 */
import { covarianceDiagnostics, portfolioStats, type CovarianceDiagnostics, type Matrix, type PortfolioPoint } from "./mpt";
import { maxDiversificationWeights, minCvarWeights, riskBudgetWeights, riskReport, type RiskStrategyResult } from "./risk-strategies";
import { expectedShortfall } from "./risk";
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

export type Objective = "max_sharpe" | "min_variance" | "target_return" | "target_risk" | "utility" | RiskObjective;

/** Risk-based objectives (Strategies Phase 2): expected returns are not used to pick the weights. */
export type RiskObjective = "risk_parity" | "max_diversification" | "min_cvar";
export const RISK_OBJECTIVES: RiskObjective[] = ["risk_parity", "max_diversification", "min_cvar"];

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
  /** risk_parity: risk budget per asset (default equal). */
  riskBudgets?: number[];
  /** min_cvar: per-period returns per asset (same periods), and confidence (default 0.95). */
  scenarios?: number[][];
  cvarConfidence?: number;
}

export interface RiskBasedReport {
  objective: RiskObjective;
  /** RCᵢ / σ_p by asset. */
  riskShares: number[];
  budgets?: number[];
  maxBudgetDeviation?: number;
  diversificationRatio: number;
  cvar?: { confidence: number; objective: number; historicalES: number | null; valueAtRisk: number; observations: number };
  iterations: number;
  residual: number;
  status: RiskStrategyResult["status"];
  method: string;
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
  /** Present for risk-based objectives. */
  riskBased?: RiskBasedReport;
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
    let riskBased: RiskBasedReport | undefined;
    const isRisk = (RISK_OBJECTIVES as string[]).includes(input.objective);
    if (isRisk && input.useRiskFree) {
      throw new OptimizerError({ code: "UNSUPPORTED_CONSTRAINT", message: "Objective แบบเน้นความเสี่ยง (risk parity / max diversification / min CVaR) ไม่ผสมกับสินทรัพย์ปลอดความเสี่ยงบนเส้น CAL", suggestion: "ปิดตัวเลือกสินทรัพย์ปลอดความเสี่ยง แล้วกันเงินสดด้วย cash reserve ตอนปรับพอร์ต" });
    }

    if (isRisk) {
      const point = (w: number[], r: RiskStrategyResult): OptimizedPoint => {
        const chk = checkWeights(w, bounds);
        return { ...portfolioStats(w, mu, cov, rf), lambda: 0, solver: { status: r.ok ? "optimal" : "max_iterations", iterations: r.iterations, kktResidual: r.residual, sumError: chk.sumError, maxBoundViolation: chk.maxBoundViolation, regularized: false } };
      };
      const report = (w: number[]) => riskReport(w, cov);
      if (input.objective === "risk_parity") {
        if (bounds.lower || bounds.upper || bounds.linear?.length) {
          throw new OptimizerError({ code: "UNSUPPORTED_CONSTRAINT", message: "Risk parity ใช้ร่วมกับขอบเขตรายตัว/ข้อจำกัดกลุ่มไม่ได้ (โจทย์ไม่ใช่ QP) — ใช้น้ำหนักต่ำสุด/สูงสุดรวมแทน หรือเลือก maximum diversification / min CVaR", suggestion: "ล้างข้อจำกัดรายตัว/ผู้ออก/หมวด" });
        }
        const r = riskBudgetWeights(cov, input.riskBudgets);
        if (!r.ok && r.status === "invalid") throw new OptimizerError({ code: "INVALID_INPUT", message: r.message ?? "risk parity ใช้ไม่ได้" });
        const chk = checkWeights(r.weights, bounds);
        if (chk.maxBoundViolation > 1e-8) {
          throw new OptimizerError({
            code: "INFEASIBLE_CONSTRAINTS",
            message: `น้ำหนัก risk parity (${input.symbols.map((s, i) => `${s} ${pct(r.weights[i])}`).join(", ")}) อยู่นอกช่วงน้ำหนัก ${pct(bounds.min)}–${pct(bounds.max)} — ไม่บังคับตัดเพราะจะไม่ใช่ risk parity แล้ว`,
            suggestion: "ขยายช่วงน้ำหนักต่ำสุด/สูงสุด หรือปรับ risk budget",
          });
        }
        const rep = report(r.weights);
        risky = point(r.weights, r);
        riskBased = { objective: "risk_parity", riskShares: rep.riskShares, budgets: r.budgets, maxBudgetDeviation: r.maxDeviation, diversificationRatio: rep.diversificationRatio, iterations: r.iterations, residual: r.residual, status: r.status, method: "Newton บน min ½yᵀΣy − Σ bᵢ ln yᵢ แล้ว w = y/Σy (RCᵢ/σ = bᵢ)" };
        warnings.push(...r.warnings);
      } else if (input.objective === "max_diversification") {
        const r = maxDiversificationWeights(cov, bounds);
        if (!r.ok) throw new OptimizerError({ code: r.status === "unsupported" ? "UNSUPPORTED_CONSTRAINT" : "INVALID_INPUT", message: r.message ?? `ไม่ลู่เข้า (${r.status})` });
        const rep = report(r.weights);
        risky = point(r.weights, r);
        riskBased = { objective: "max_diversification", riskShares: rep.riskShares, diversificationRatio: rep.diversificationRatio, iterations: r.iterations, residual: r.residual, status: r.status, method: "max σᵀw/√(wᵀΣw) ผ่าน min zᵀCz (C = correlation) ด้วย QP เดิม" };
        warnings.push(...r.warnings);
      } else {
        if (!input.scenarios?.length) throw new OptimizerError({ code: "INVALID_INPUT", message: "Min CVaR ต้องใช้ผลตอบแทนรายงวดในอดีต (scenarios)" });
        const alpha = input.cvarConfidence ?? 0.95;
        const r = minCvarWeights({ scenarios: input.scenarios, alpha, bounds });
        if (!r.ok) throw new OptimizerError({ code: r.status === "infeasible" ? "INFEASIBLE_CONSTRAINTS" : "INVALID_INPUT", message: r.message ?? `ไม่ลู่เข้า (${r.status})` });
        const port = input.scenarios[0].map((_, t) => r.weights.reduce((acc, w, i) => acc + w * input.scenarios![i][t], 0));
        const rep = report(r.weights);
        risky = point(r.weights, r);
        riskBased = {
          objective: "min_cvar",
          riskShares: rep.riskShares,
          diversificationRatio: rep.diversificationRatio,
          cvar: { confidence: alpha, objective: r.cvar, historicalES: expectedShortfall(port, alpha, 0), valueAtRisk: r.valueAtRisk, observations: r.observations },
          iterations: r.iterations,
          residual: 0,
          status: r.status,
          method: "Rockafellar–Uryasev: min ζ + Σ(uₜ)/((1−α)T) เป็น linear program (simplex) บนผลตอบแทนจริงรายงวด",
        };
        warnings.push("CVaR เป็นค่าต่องวด (เช่นรายวัน) จากข้อมูลในอดีต ไม่ใช่การคาดการณ์");
      }
    } else if (input.useRiskFree) {
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
      ...(riskBased ? { riskBased } : {}),
      constraints: { n: mu.length, min: bounds.min, max: bounds.max, longOnly: bounds.min >= 0, riskFree: input.useRiskFree },
      covariance: { minEigenvalue: diag.minEigenvalue, maxEigenvalue: diag.maxEigenvalue, conditionNumber: diag.conditionNumber, psd: diag.psd },
      warnings,
    };
  } catch (e) {
    if (e instanceof OptimizerError) return { ok: false, issue: e.issue, warnings };
    throw e;
  }
}
