import { resolveRiskFree, type RiskFreeRequest } from "@/lib/finance/risk-free";
import { readTimestampPolicy } from "@/lib/governance";
import { today } from "@/lib/validation";
import { getSettings, getYieldCurve } from "./settings";

/** Risk-free rate with provenance from Settings + the stored yield curve (see lib/finance/risk-free.ts). */
export async function getRiskFree(req: RiskFreeRequest = {}) {
  const [settings, curve] = await Promise.all([getSettings(), getYieldCurve()]);
  return resolveRiskFree(req, {
    baseCurrency: settings.baseCurrency,
    settingsRatePct: settings.riskFreeRate,
    settingsSource: settings.rfSource,
    settingsAsOf: settings.rfAsOf,
    curve,
    maxAgeDays: readTimestampPolicy(settings.timestampPolicy).inputsMaxAgeDays,
    today: today(),
  });
}
