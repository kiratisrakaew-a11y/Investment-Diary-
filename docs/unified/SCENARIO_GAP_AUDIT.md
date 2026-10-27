# Scenario & probabilistic valuation — gap audit (PR11)

HEAD inspected: `fc4c9a6` on `claude/vigilant-fermi-tf3wq7`. Decision Tree and event-driven valuation are out of scope and not built.

## Reused (not copied)

| Piece | Location | Used for |
|---|---|---|
| `evaluate()` / `evaluateCore()` | `src/lib/valuation-schemas.ts` | The only evaluator. A `lean` flag skips sensitivity grids, reverse DCF and calculation steps; the model maths are unchanged. It is exported as `evaluateLean` |
| `valuationInput` (zod) | same | Every scenario input is re-validated after overrides |
| `applyScenario` (DCF fade / stage overrides) | `src/lib/finance/valuation.ts` | `scenario: "<name>"` applies a model's own legacy scenario |
| RIM scenario rules (`applyRimScenario`) | `src/lib/finance/rim-horizon.ts` | `roeShift` / `payoutRatio` follow the same rules. Parity is tested against `rimScenarioAnalysis` |
| `dcfAtRate` | `valuation.ts` | `discountRate` driver (sensitivity / reverse / Monte Carlo) |
| `sotp()` + `measureSegment()` | `src/lib/finance/sotp.ts`, `valuation-schemas.ts` | Each scenario reruns every segment model and the whole bridge; the reconciliation difference is checked |
| `covarianceDiagnostics` | `src/lib/finance/mpt.ts` | PSD check and repair of the Monte Carlo correlation matrix |
| `MODEL_VERSION`, `saveValuation` | `governance.ts`, `server/services/valuations.ts` | Snapshot version and persistence |

## Gaps found and how they are closed

| Method | Before | Added |
|---|---|---|
| FCFF / FCFE (linear and staged) | Scenarios and weighted value existed but required Σ = 1 within 1e-6, with no base-vs-weighted naming, no MoS per scenario and no quality status | Shared engine with Σ = 1 within 1e-8, `baseCaseValue` ≠ `probabilityWeightedValue`, upside and MoS per scenario, path overrides (`growthShift`, `marginShift`, `stages[id].field`, WACC inputs, terminal inputs) |
| Residual income | Scenarios at the full horizon | The same engine; legacy results are reproduced exactly |
| DDM | None | Overrides for d0, growth stages, Ke inputs |
| Multiples | None | Overrides for EPS / BV / EBITDA / net debt / target multiples |
| SOTP | **Segment scenarios were ignored at the top level** (the PLANB #31 symptom) | Path targeting by stable segment id (`id` → `entity` → `name`, never index); `mode: "from_segments"` builds one SOTP scenario per shared segment-scenario name and reruns the bridge; scenario-specific net debt, minority interest, holding discount, ownership, FX, stake price and line items; duplicate ids rejected; material bridge warnings make the result `preliminary` |
| Bond | ±bp price table, not probability-weighted | `yieldShiftBp` / `ytm` / horizon inputs. The weighted value is a clean price per 100, never an equity value |

## Contracts

- Input: optional `assumptions.scenarioSet` = `{ version: 1, mode: custom | from_segments, scenarios[], sensitivity?, reverse?, monteCarlo? }`, defined in `src/lib/valuation-scenario-schema.ts`. Old records have no `scenarioSet`, so `evaluate()` returns exactly what it did before. This is tested.
- Output: `ScenarioSummary` contains:
  - `baseCaseValue`, `probabilityWeightedValue`, `sumProbability` and `scenarios[]`;
  - per scenario: value, equity value, upside, MoS, resolved inputs, warnings, errors and the SOTP bridge;
  - `currency`, `asOf`, `modelVersion`, `qualityStatus`, `qualityReasons`.
- Quality status:
  - `insufficient_data` when the base value fails.
  - `preliminary` when there is a material SOTP code (MINORITY_DOUBLE_COUNT, MISSING_MINORITY, DEBT_DOUBLE_COUNT, DEBT_OMITTED, CASH_DOUBLE_COUNT, INVESTMENT_DOUBLE_COUNT, DUPLICATE_ENTITY, EV_NEEDS_OWN_DEBT, MISSING_SEGMENT_DEBT, SEGMENT_DEBT_IGNORED) or no `inputMeta.asOf`.
  - Otherwise `verified_inputs`.
- Persistence: scenario inputs live in `assumptions.scenarioSet`, and the computed snapshot in `result.scenarioAnalysis`. JSON columns are used and no migration is needed. `intrinsicValue` remains the base value.

## PLANB #31

The production database is not reachable from this environment, so record 31 cannot be read here. A synthetic PLANB-like fixture (core OOH + Engagement DCF with Bear/Base/Bull, plus a market-valued COM7 stake) is used instead. On that fixture:

- The base value is unchanged.
- The weighted value is computed only through `from_segments`.
- `minorityInterest` with no partially owned consolidated segment raises `MINORITY_DOUBLE_COUNT` and the result becomes `preliminary`.

Saved records are never rewritten. A weighted value appears only once the user adds a `scenarioSet` and saves.

iCare is not added automatically.
