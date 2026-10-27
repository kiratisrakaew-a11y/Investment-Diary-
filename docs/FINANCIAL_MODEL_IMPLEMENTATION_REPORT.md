# Financial model hardening — implementation report

Companion to [`FINANCIAL_MODEL_AUDIT.md`](FINANCIAL_MODEL_AUDIT.md).

## Decisions taken by the owner

1. Stress totals use the value floored at −100%, with the linear value shown alongside.
2. Bond scenarios live in page state only; they are not saved.

## A. Repository baseline

- **Branch:** `claude/vigilant-fermi-tf3wq7`.
- **Audit:** made at `dc7de23`, published as `5ef2108`.
- **Implementation commits:**
  - `eb42f78` — Phase 1
  - `8113939` — Phase 2
  - `d549658` — Phase 3
  - `340f1af` — Phases 4–5
  - the commit that adds this report — Phase 6
- **Baseline at audit time:** 53 test files / 545 tests passed; tsc and lint clean.
- **Modules and capabilities:** see the audit, sections 1–12. Every engine listed in the specification already existed, except multi-horizon VaR (H-1) and portfolio Monte Carlo. Portfolio Monte Carlo was not built; it is reported as a gap only.

## B. Confirmed issues and fixes

| ID | Severity | File | Root cause | Financial impact | Fix |
|---|---|---|---|---|---|
| S-1 | P0 bug | `src/lib/finance/stress.ts` | Linear β / duration / specific shocks were summed with no bound | A long, fully paid position could lose more than its value (β 1.8 × −60% gave −108%, NAV −8) | Position return floored at −100%. `linearReturn` and `boundedAtFullLoss` added to the output. Factor lines are scaled so they sum to the floored total, and a warning is issued per position. StressPanel shows "เส้นตรง x% → จำกัดที่ −100%" |
| M-1 | P0 bug (UI) | `src/components/ScenarioWorkbench.tsx` | Any variable edit set `correlation: undefined` | A correlation matrix set through API or MCP was silently deleted | Edits keep the matrix. Adding or removing a variable resizes it and keeps the other pairs |
| M-2 | P0 gap | same | No correlation editor | Correlation could only be set through API or MCP | Independent / manual modes; n×n editor (upper triangle mirrored, diagonal fixed at 1); dimension, diagonal, range, symmetry and PSD checks; the run is blocked on a non-PSD matrix; the repaired matrix is shown and applied only after confirmation |
| H-1 | P0 gap | `src/lib/finance/var-backtesting.ts`, `metrics.ts`, analytics page | Only one-period VaR plus a √10 approximation | No horizon VaR or ES | `horizonVarTable` covers 1 period, 10 periods, ≈1 month, ≈1, 3 and 5 years, using compounded R_H = Π(1+r) − 1 (non-overlapping, or labelled overlapping windows with ≥ 10 independent windows). A horizon is unavailable when history is too short; there is no √h extrapolation. The table shows THB amounts and the √h figure for comparison only. The export label "VaR_1วัน" became "1 งวด" |
| D-1 | P1 data quality | `portfolio.ts`, `metrics.ts`, `services/portfolio.ts` | The union calendar valued positions at carried prices, producing artificial 0% periods | σ, Sharpe, Sortino and VaR are biased on mixed-calendar portfolios | Each series point counts carried positions. Risk statistics use synchronised dates (wealth index linked across skipped dates); TWR, CAGR, XIRR and drawdown are unchanged. If too few synchronised dates exist, all dates are used and a warning is shown. `riskSample` is reported |
| B-1 | P1 gap | `BondCalculator.tsx`, new `BondScenarios.tsx`, `lib/bond-scenarios.ts` | The engine supported bond scenarios but the UI did not | Only a single yield shock was available in the calculator | Bear/Base/Bull/custom scenarios: yield shift now, exit yield, reinvestment rate and probability. Price now comes from `runScenarios` (full repricing) and horizon return from the same bond evaluator. The weighted clean price and weighted horizon return appear only when Σp = 1. Page state only |
| §14.5 | P1 gap | `src/lib/finance/bonds.ts` `horizonReturn` | Coupon and reinvestment were combined | YTM vs realised return was unclear | Added `couponIncome`, `reinvestmentIncome`, `principalReceived` and `priceReturn` (they sum to future value − purchase). The calculator labels YTM as a hold-to-maturity figure, not a realised return |
| FCFE NCI | P2 (unverified concern) | `valuation.ts`, `valuation-schemas.ts` | FCFE bridge never deducts minorities | Double count if consolidated net income is forecast | Optional `netIncomeBasis` (default `attributable` = previous values; `consolidated` deducts `otherClaims` once). A warning appears when minorities exist and the basis is unstated |
| RIM g | P2 limitation | `valuation-schemas.ts`, ValuationEditor | Single-stage RIM and justified multiples take any g | ROE, payout and g may contradict each other | Warning when \|g − ROE·(1 − payout)\| > 1 pt; sustainable g is shown; the value is unchanged |
| Sortino MAR | P2 gap | metrics, settings | MAR was fixed at Rf | Methodology not selectable | `settings.sortino_mar_pct` (empty = Rf, so default output is identical); the MAR used is shown |
| MPT label | P2 | analytics page | Price returns were not labelled | Dividends omitted without saying so | Panel labelled as price return (dividends excluded) |

## C. Changes

- **Added:**
  - `src/components/BondScenarios.tsx`
  - `src/lib/bond-scenarios.ts` (+ test)
  - `drizzle/0015_sortino_mar.sql` (+ snapshot)
  - tests: `stress-bounds`, `var-horizons`, `metrics-sync`, `valuation-correlation`, `valuation-audit-p2`
- **Modified:**
  - `stress.ts`, `var-backtesting.ts`, `metrics.ts`, `portfolio.ts`, `bonds.ts`, `valuation.ts`
  - `valuation-schemas.ts`, `valuation-montecarlo.ts`, `validation.ts`, `db/schema.ts`
  - `services/portfolio.ts`, `services/settings.ts`, `app/(app)/actions.ts`
  - pages: analytics, settings
  - components: `StressPanel`, `ScenarioWorkbench`, `BondCalculator`, `ValuationEditor`
  - `scripts/scenario-parity-check.ts`
- **Removed:** none.
- **Reused without change of maths:**
  - `historicalVaR`, `expectedShortfall`, `periodReturns`
  - `covarianceDiagnostics` (through the new `checkCorrelation`, which `prepareCorrelation` now delegates to — same checks and repair)
  - `runScenarios`, `applyOverrides`, `evaluateLean`, `analyticsFromYield`, `horizonReturn`
- **New functions:**
  - `horizonReturns`, `horizonVarTable`
  - `checkCorrelation`, `identityCorrelation`, `setCorrelationPair`, `removeCorrelationIndex`, `appendCorrelationIndex`
  - `presetBondScenarios`, `bondScenarioResults`
- **API / MCP:** additive response fields only:
  - stress: `positions[].linearReturn`, `boundedAtFullLoss`
  - performance: `varHorizons`, `riskSample`, `sortinoMar`, `sortinoMarBasis`
  - bond analysis: horizon decomposition fields
  - optional `netIncomeBasis` input on DCF
  - No route, tool name or required field changed.
- **Database:** migration 0015 adds a nullable column (`settings.sortino_mar_pct`). Rollback: drop the column; older code ignores it.

## D. Mathematical verification

| Formula | Test input | Expected (independent) | Actual | Tolerance | Result |
|---|---|---|---|---|---|
| Stress floor | β 1.8, ΔRm −60%, V 100 | linear −108%, P&L −100, NAV 0 | identical | 1e-12 | pass |
| Stress within range | β 1.2 × −20%; bond D 5, C 30, Δy +1% | −24; 100·(−0.05 + 0.0015) | identical | 1e-12 | pass |
| R_H compounding | r = 0.1, −0.5, 0.2, 0.1, −0.1; h = 2 | −0.4, −0.01 | identical | 1e-12 | pass |
| Long-only bound | 30 × −60%, h = 5 | 0.4⁵ − 1 = −98.98% (≥ −100%) | identical | 1e-12 | pass |
| 10-period VaR | deterministic 1,000-day cycle | type-7 quantile of compounded windows | identical | 1e-12 | pass |
| Synchronised σ | 2 assets, A carried every 5th day | σ of the index sampled on 241 synchronised dates × √N | identical | 1e-12 | pass |
| Copula correlation | N(0,1) marginals, ρ = 0.8 / 0 / −0.6 | sd(X+Y) = √(2+2ρ) = 1.897 / 1.414 / 0.894 | within ±5% | sampling | pass |
| PSD repair | ρ₁₂ = 0.9, ρ₁₃ = −0.9, ρ₂₃ = 0.9 | unit diagonal, symmetric, PSD after repair | pass; input not mutated | 1e-12 | pass |
| Bond scenario price | 5y 3% semi-annual at 4% ± shift | `analyticsFromYield(4% + shift)` | identical | 1e-8 | pass |
| Weighted clean price | 25/50/25 | Σ p·P | identical | 1e-8 | pass |
| Horizon decomposition | sell after 2 years at 5%, reinvest 3% | coupons 6; reinvestment 1.5·(1.015³ + 1.015² + 1.015 + 1) − 6; price change = sale − purchase | identical | 1e-10 | pass |
| FCFE consolidated | `otherClaims` 500 | equity lower by exactly 500 | identical | 1e-9 | pass |
| RIM g check | ROE 12%, payout 50%, g 3% | warning naming 6.00%; V = 10 + 0.03·10/0.06 | identical | 1e-12 | pass |
| Sortino MAR 0 | synthetic 400-day path | mean(r)·N / √(Σ min(0, r)²/n)·√N | identical | 1e-10 | pass |
| Audit reference script (`audit/verify.mts`, re-run) | see audit | — | 30/30 asserted cases pass; the stress case now gives P&L −100, NAV 0 with a warning (was −108 / −8) | — | pass |

## E. Regression (commands actually run, Phase 6)

| Command | Result |
|---|---|
| `npx vitest run` | 59 files, 574 tests passed |
| `npx tsc --noEmit -p .` | exit 0 |
| `npm run lint` | no warnings or errors |
| `npm run build` | compiled successfully |
| `npm run db:migrate` | migrations applied (0015) |
| `npm run check:asset-lifecycle` | ALL PASSED |
| `npm run check:valuation-roundtrip` | ALL PASSED |
| `npm run check:scenario-parity` (DB plus running server; now includes correlated Monte Carlo service = REST = MCP) | ALL PASSED |
| Optimizer baseline (6 objectives) | max \|Δ\| = 0 |
| `e2e/valuation-smoke.mjs` (375–1440 px, both themes) | ALL PASSED |
| Playwright: correlation editor, bond scenarios, analytics horizon table, settings MAR field (dim and light) | no console errors, no horizontal scroll at 390 px |

Test data (TEST-LOCAL / TLC-*) was removed. Database counts are back to 6 assets / 17 transactions / 3,120 prices / 3 valuations.

## F. Remaining limitations

- **D-1 on production data:** local data has one calendar, so the size of the effect on production data was not measured. The behaviour is covered by synthetic tests.
- **Horizon VaR history:** 1-, 3- and 5-year horizons need about 10× the horizon in history. With about 2 years of data they show "ข้อมูลไม่พอ"; this is intended.
- **Portfolio Monte Carlo:** not implemented (a separate model, out of scope).
- **Bond scenarios:**
  - not saved (owner decision);
  - parallel yield shifts only (no curve twists);
  - callable bonds may be non-linear and are warned about in the UI.
- **Monte Carlo correlation:** applied in Gaussian-copula space and entered by the user. It is not estimated from history, because no synchronised driver data exists.
- **Ledoit–Wolf vs sample covariance:** the T vs T−1 scaling difference is documented and not changed.
- **FCFE basis:** `netIncomeBasis` is not yet exposed as a field in the editor form; it is available through JSON, API and MCP. The warning is shown in the editor.

## G. Backward compatibility

- **Portfolio records, transactions and bond records:** not modified. TWR, XIRR and the snapshot are unchanged (tests).
- **Valuations and saved assumptions:**
  - unchanged; the new fields are optional and default to the previous behaviour;
  - DCF golden tests pass;
  - the parity script confirms a legacy SOTP record re-saves unchanged.
- **REST endpoints and MCP tools:** same names and inputs; responses only gained fields.
- **Default outputs:**
  - Sortino with MAR unset, VaR one-period figures and optimizer outputs are identical to before.
  - Stress results differ only where a position previously exceeded −100%. That is the confirmed bug.
