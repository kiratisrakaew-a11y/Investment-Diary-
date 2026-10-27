# Valuation + Airy Glass UI — P0 gap audit

| | |
|---|---|
| Branch / HEAD | `claude/vigilant-fermi-tf3wq7` @ `ac78d85` (clean tree) |
| Baseline gates | `npm test` 409/409, `npm run typecheck`, `npm run lint`, `npm run build`: all PASS on the previous commit |
| Golden fixtures | `src/lib/finance/valuation-golden.test.ts` — values recorded at `ac78d85` (FCFF / FCFE incl. mid-year, stable ROIC, exit multiple, explicit schedule, sensitivity, scenarios, reverse DCF; single and multi-stage RIM; DDM) plus two independent hand calculations (2-year FCFF = 295; 2-year RIM = 10.929752). Tolerance 1e-8 |

## Feature matrix

| Requirement | Existing | Gap | Action | Paths |
|---|---|---|---|---|
| CAPM / WACC / FCFF / FCFE / 3 terminal methods / mid-year / FCFE debt policy | EXISTS | — | No-op (reuse) | `lib/finance/valuation.ts` (`dcf`, `forecast`, `terminal`, `bridge`) |
| Multi-stage DCF | PARTIAL — one global linear fade of growth and margin | Independent stage drivers | EXTEND: optional `forecastMode: "linear_fade" \| "staged"` + `stages[]` expanded into the same per-year driver table consumed by the existing `forecast()` (no second engine) | `valuation.ts`, `valuation-schemas.ts`, `valuation-explain.ts` |
| Scenarios / sensitivity / reverse DCF | EXISTS (fade fields) | Stage awareness | EXTEND: explicit `stageOverrides`; sensitivity shifts stage margins / capex / δ; reverse DCF solves a uniform shift of stage growth | `valuation.ts` |
| Multi-stage RIM | EXISTS (yearly ROE / EPS / payout / BV, clean surplus, perpetuity / persistence / none, EPS priority, BV-override warning) | 5Y vs 10Y comparison, ω / Ke sensitivity, richer warnings | EXTEND: `riHorizonComparison` reusing `multiStageResidualIncome` on the first N years of one dataset; no auto-extrapolation | `valuation.ts`, editor |
| DDM, multiples, SOTP | EXISTS | — | No-op; SOTP nests `evaluate()` so staged DCF flows through | `sotp.ts` |
| Persistence | `valuations.assumptions` JSON parsed by the zod schemas; `result.modelVersion` | — | Optional fields only → **no DB migration**; bump `MODEL_VERSION` | `services/valuations.ts`, `governance.ts` |
| Editor | `ValuationEditor.tsx` (1,054 lines): `RiForecastEditor`, `DcfTables`, `ScenarioPanel`, `FootballField`, `ReverseDcf` | Stage editor, horizon comparison | NEW small components under `components/valuation/`; editor keeps orchestration | |
| Valuation list / stock pages | Card tables | Airy glass overview | EXTEND pages; reuse tokens | `app/(app)/valuation/**` |
| Design tokens | `globals.css`: `dim` (navy glass) / `light`, `.glass`, `.card`, `--panel-solid` | Airy palette, strong surfaces for grids, reduced-transparency / motion fallbacks, focus ring | REFINE the same tokens (no parallel kit) | `globals.css` |
| API / MCP | `value_security`, `/api/v1/valuation`, `/api/v1/valuation/residual-income` | — | Payloads unchanged; new fields optional | |

## Units and conventions (unchanged)

- Rates are decimals (0.09 = 9%).
- Revenue, debt, cash and shares share one scale (e.g. THB million and million shares). Per-share values are in currency.
- Years are fiscal years. Year t is discounted at t (or t − ½ under mid-year).
- A perpetuity TV is discounted at n (n − ½ under mid-year); an exit-multiple TV is discounted at n.
- `inputMeta.asOf` and sources are recorded with the market inputs.
- **FCFF bridge:** EV − debt + cash − other claims.
- **FCFE bridge:** PV + cash. Interest income on cash is not in forecast net income, so cash is added once.

## Risks

- **Staged mode:** `years` is derived from Σ stage years. A mismatch is reported as a warning, and the stage total is used. Stage counts other than 2–4, non-integer years or a total outside 1–20 are errors (never clamped).
- **Legacy scenario fields:** in staged mode, legacy fade fields in scenarios would be ambiguous. They are rejected with a message asking for `stageOverrides`.
