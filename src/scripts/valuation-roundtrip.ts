/**
 * Integration check against the real database: save → read → evaluate and JSON export → import for
 * staged DCF, legacy DCF, multi-stage RIM with scenarios and a RIM horizon snapshot.
 * Creates rows titled "TEST-LOCAL roundtrip" and always deletes them. Run: npm run check:valuation-roundtrip
 */
import "dotenv/config";
import { DEFAULT_DCF, defaultScenarios, type DcfAssumptions } from "../lib/finance/valuation";
import { defaultRimScenarios } from "../lib/finance/rim-horizon";
import { evaluate, riHorizonSnapshot, residualIncomeSchema, valuationInput, type ValuationInput } from "../lib/valuation-schemas";
import { exportValuationFile, parseValuationImport } from "../lib/governance";
import { deleteValuation, getValuation, saveValuation, valuationsForSymbol } from "../server/services/valuations";

const SYMBOL = process.argv[2] ?? "PTT";
const TITLE = "TEST-LOCAL roundtrip";

const staged: DcfAssumptions = {
  ...DEFAULT_DCF,
  forecastMode: "staged",
  years: 10,
  stages: [
    { name: "High", years: 3, revenueGrowthStart: 0.12, revenueGrowthEnd: 0.1, ebitMarginStart: 0.14, ebitMarginEnd: 0.15 },
    { name: "Transition", years: 4, revenueGrowthStart: 0.08, revenueGrowthEnd: 0.05, ebitMarginStart: 0.15, ebitMarginEnd: 0.16 },
    { name: "Mature", years: 3, revenueGrowthStart: 0.04, revenueGrowthEnd: 0.03, ebitMarginStart: 0.16, ebitMarginEnd: 0.16, capexPct: 0.04 },
  ],
};
const ri = residualIncomeSchema.parse({
  bookValuePerShare: 40,
  roe: 0.1,
  payoutRatio: 0.5,
  currentPrice: 30,
  riskFree: 0.025,
  beta: 1,
  equityRiskPremium: 0.065,
  terminalGrowth: 0.02,
  model: "multi_stage",
  terminalMethod: "persistence",
  persistence: 0.6,
  forecast: [0.12, 0.12, 0.115, 0.11, 0.105, 0.1, 0.098, 0.096, 0.094, 0.092].map((roe) => ({ roe })),
  scenarios: defaultRimScenarios(),
});

const cases: [string, ValuationInput][] = [
  ["staged FCFF + stage scenarios", { method: "dcf_fcff", assumptions: { ...staged, scenarios: defaultScenarios(staged) } }],
  ["staged FCFE", { method: "dcf_fcfe", assumptions: staged }],
  ["legacy FCFF (no forecastMode)", { method: "dcf_fcff", assumptions: DEFAULT_DCF }],
  ["multi-stage RIM + scenarios", { method: "residual_income", assumptions: ri }],
  ["RIM 5-year snapshot", { method: "residual_income", assumptions: riHorizonSnapshot(ri, 5, "roundtrip") }],
];

const close = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
const ids: number[] = [];
let failed = 0;
try {
  for (const [name, input] of cases) {
    const expected = evaluate(valuationInput.parse(input)).value;
    const { valuation } = await saveValuation({ symbol: SYMBOL, title: `${TITLE} · ${name}`, note: "", valuation: input, source: "api" });
    ids.push(valuation.id);
    const row = await getValuation(valuation.id);
    const reread = valuationInput.parse({ method: row!.method, assumptions: row!.assumptions });
    const again = evaluate(reread).value;
    const imp = parseValuationImport(JSON.stringify(exportValuationFile({ symbol: SYMBOL, valuation: reread })));
    const imported = imp.ok ? evaluate(imp.valuation).value : null;
    const ok = close(expected, row!.intrinsicValue) && close(expected, again) && close(expected, imported);
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(32)} computed ${expected?.toFixed(6)} · stored ${row!.intrinsicValue?.toFixed(6)} · re-read ${again?.toFixed(6)} · JSON import ${imported?.toFixed(6)}`);
  }
  // A saved snapshot must not become the method's current view.
  const group = await valuationsForSymbol(SYMBOL);
  const snapId = ids[ids.length - 1];
  const okGroup = !group?.latestByMethod.some((r) => r.id === snapId) && group?.all.some((r) => r.id === snapId);
  if (!okGroup) failed++;
  console.log(`${okGroup ? "PASS" : "FAIL"}  snapshot listed but not latest-per-method`);
} finally {
  for (const id of ids) await deleteValuation(id);
  console.log(`cleaned up ${ids.length} test rows`);
}
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
