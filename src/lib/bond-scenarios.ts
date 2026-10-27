/**
 * Named bond scenarios for the bond calculator (audit B-1). Reuses the shared scenario engine: the
 * clean price under each yield shift comes from `runScenarios` (method "bond"), and the horizon
 * return from the same bond evaluator with the scenario's exit yield and reinvestment rate, bought at
 * today's price. No pricing formula here.
 */
import { evaluateLean, type ValuationInput } from "./valuation-schemas";
import { applyOverrides, runScenarios, validateProbabilities } from "./valuation-scenarios";

export interface BondScenarioRow {
  id: string;
  name: string;
  probability: number;
  /** Instant parallel yield shift (bp) applied to today's yield. */
  shiftBp: number;
  /** Yield when sold at the horizon date (decimal); null = today's YTM. */
  exitYield: number | null;
  /** Coupon reinvestment rate (decimal); null = the calculator's rate. */
  reinvestRate: number | null;
}

export type BondHorizon = { totalReturn: number; annualizedReturn: number; futureValue: number; couponIncome: number; reinvestmentIncome: number; priceReturn: number };

export function presetBondScenarios(ytm: number, reinvest: number): BondScenarioRow[] {
  const r4 = (x: number) => Number(x.toFixed(6));
  return [
    { id: "bear", name: "Bear", probability: 0.25, shiftBp: 100, exitYield: r4(ytm + 0.01), reinvestRate: r4(reinvest + 0.005) },
    { id: "base", name: "Base", probability: 0.5, shiftBp: 0, exitYield: null, reinvestRate: null },
    { id: "bull", name: "Bull", probability: 0.25, shiftBp: -50, exitYield: r4(ytm - 0.005), reinvestRate: r4(reinvest - 0.005) },
  ];
}

/** Price now and horizon return per scenario, plus probability-weighted values (null unless valid). */
export function bondScenarioResults(base: ValuationInput, rows: BondScenarioRow[], withHorizon: boolean) {
  // Price now does not depend on the horizon settings (an invalid horizon date must not block it).
  const { horizon: _h, ...noHorizon } = base.assumptions as Record<string, unknown>;
  const summary = runScenarios({ method: base.method, assumptions: noHorizon } as ValuationInput, {
    scenarios: rows.map((s) => ({ id: s.id, name: s.name, probability: s.probability, inputOverrides: (s.shiftBp ? { yieldShiftBp: s.shiftBp } : {}) as Record<string, number> })),
  });
  const horizons = rows.map((s): BondHorizon | { error: string } | null => {
    if (!withHorizon) return null;
    const over: Record<string, number> = {};
    if (s.exitYield != null) over["horizon.exitYield"] = s.exitYield;
    if (s.reinvestRate != null) over["horizon.reinvestRate"] = s.reinvestRate;
    const a = applyOverrides(base, over);
    if (!a.input) return { error: a.errors.join("; ") };
    try {
      const h = (evaluateLean(a.input).details as { horizon?: BondHorizon | null }).horizon;
      return h ?? { error: "ไม่มีผล horizon" };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });
  const probErrors = validateProbabilities(rows);
  const okH = withHorizon && !probErrors.length && horizons.every((h, i) => rows[i].probability === 0 || (h != null && !("error" in h)));
  const weightedHorizon = okH ? rows.reduce((t, s, i) => (s.probability > 0 ? t + s.probability * (horizons[i] as BondHorizon).totalReturn : t), 0) : null;
  return { summary, horizons, weightedHorizon, probErrors };
}

