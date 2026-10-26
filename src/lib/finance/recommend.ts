/**
 * Turns optimizer inputs + the investor's preferences into a concrete weight
 * recommendation and trade list. Shared by the interactive optimizer page,
 * the AI advisor and the MCP / REST tools so every surface gives the same answer.
 */
import { portfolioStats, type Matrix, type PortfolioPoint } from "./mpt";
import {
  analyticFrontier,
  completePortfolio,
  constrainedFrontier,
  constrainedMeanVariance,
  constrainedTargetReturn,
  constrainedTargetRisk,
  type Bounds,
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
  objective: Objective;
  risky: PortfolioPoint;
  /** Fraction of wealth in the risky portfolio (1 when useRiskFree = false). */
  riskyShare: number;
  riskFreeShare: number;
  final: { expectedReturn: number; volatility: number; sharpe: number | null };
  allocations: { symbol: string; weight: number; currentWeight: number; targetValue: number; currentValue: number; trade: number }[];
  current: PortfolioPoint | null;
  gmv: PortfolioPoint;
  tangency: PortfolioPoint;
  unconstrained: ReturnType<typeof analyticFrontier>;
  bullet: { volatility: number; expectedReturn: number; efficient: boolean }[];
  notes: string[];
}

export function recommend(input: RecommendInput): RecommendResult {
  const { mu, cov, rf, bounds } = input;
  const notes: string[] = [];
  const frontier = constrainedFrontier(mu, cov, rf, bounds, 30);
  const unconstrained = analyticFrontier(mu, cov, rf, 80);

  let risky: PortfolioPoint;
  switch (input.objective) {
    case "min_variance":
      risky = frontier.gmv;
      break;
    case "target_return": {
      const t = input.targetReturn ?? frontier.tangency.expectedReturn;
      risky = portfolioStats(constrainedTargetReturn(mu, cov, t, bounds), mu, cov, rf);
      if (Math.abs(risky.expectedReturn - t) > 0.002) notes.push("ผลตอบแทนเป้าหมายอยู่นอกช่วงที่ทำได้ภายใต้ข้อจำกัด — ใช้ค่าที่ใกล้ที่สุดแทน");
      break;
    }
    case "target_risk":
      risky = constrainedTargetRisk(mu, cov, rf, input.targetRisk ?? frontier.tangency.volatility, bounds);
      if (input.targetRisk != null && risky.volatility > input.targetRisk + 1e-6) notes.push("ความเสี่ยงเป้าหมายต่ำกว่าพอร์ต min-variance — ใช้พอร์ต min-variance แทน");
      break;
    case "utility":
      // max μᵀw − (A/2) wᵀΣw  ⇔  min wᵀΣw − (2/A) μᵀw
      risky = portfolioStats(constrainedMeanVariance(mu, cov, 2 / Math.max(input.riskAversion, 0.1), bounds), mu, cov, rf);
      break;
    default:
      risky = frontier.tangency;
  }

  let riskyShare = 1;
  if (input.useRiskFree) {
    // Two-fund separation: hold the tangency portfolio and lend/borrow at Rf.
    if (input.objective !== "max_sharpe") notes.push("เมื่อรวมสินทรัพย์ปลอดความเสี่ยง ทฤษฎี two-fund separation ใช้พอร์ต tangency เป็นส่วนเสี่ยง");
    risky = frontier.tangency;
    const cp = completePortfolio(risky, rf, input.riskAversion);
    riskyShare = Math.min(Math.max(cp.riskyShare, 0), 1);
    if (cp.riskyShare > 1) notes.push(`y* = ${(cp.riskyShare * 100).toFixed(0)}% (ต้องกู้ยืม) — จำกัดไว้ที่ 100% เพราะไม่ใช้ margin`);
  }
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
    return {
      symbol,
      weight,
      currentWeight: wealth > 0 ? currentValue / wealth : 0,
      targetValue,
      currentValue,
      trade: targetValue - currentValue,
    };
  });

  if (frontier.tangency.expectedReturn <= rf) notes.push("ผลตอบแทนคาดหวังของสินทรัพย์เสี่ยงไม่สูงกว่า Rf — ตรวจสอบสมมติฐานผลตอบแทน");

  return {
    objective: input.objective,
    risky,
    riskyShare,
    riskFreeShare: 1 - riskyShare,
    final: { expectedReturn: er, volatility: vol, sharpe: vol > 0 ? (er - rf) / vol : null },
    allocations,
    current,
    gmv: frontier.gmv,
    tangency: frontier.tangency,
    unconstrained,
    bullet: frontier.curve.map(({ volatility, expectedReturn, efficient }) => ({ volatility, expectedReturn, efficient })),
    notes,
  };
}
