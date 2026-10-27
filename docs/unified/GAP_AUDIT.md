# Unified roadmap PR0–PR16 — gap audit (Phase A)

Audited on branch `claude/vigilant-fermi-tf3wq7` at `e50a64e` (2026-10-27), which is the same commit the spec cites; no newer remote commits.

**Baseline gates at `e50a64e`:**
- `vitest` 463/463 pass; `tsc` clean; `npm run lint` clean; `next build` passes.
- `npm run check:valuation-roundtrip` passes. `e2e/valuation-smoke.mjs` passes 50/50.

**Deployment model:** single user. One `APP_PASSWORD` session cookie (web) and one `API_KEY` (REST/MCP); there are no user or tenant tables. "Per-user" or "scoped" preferences in the spec therefore apply to the single owner. Nothing can leak across users because there is only one.

**Blocked in this environment:**
- The production database is not reachable. Valuation ID 31 (PLANB) and the assets AP, BBL, KBANK, PLANB, SCB and TISCO do not exist in the local database, which has six dev assets: PTT, CPALL, AAPL, GOLD, K-FIXED and LB29DA.
- So the PLANB #31 regression is covered with a synthetic SOTP fixture that has the same structure (a scenario-bearing DCF segment plus a market-valued stake that triggers `MINORITY_DOUBLE_COUNT`). It is never run against the real record.

Legend: **Done** = verified at HEAD, reused · **Extend** = exists, needs additions · **Missing** = to build.

## PR0–PR7 (bonds, risk-free rate, optimizer, short selling)

| Item | Status | Where / note |
|---|---|---|
| Constrained QP (box + general linear, typed infeasibility, no silent relaxation) | Done | `optimizer.ts` `solveBoxQP`, `solveGeneralQP` (Goldfarb–Idnani), `validateBounds`, `OptimizerError` |
| GMV / target return / target risk / max Sharpe / utility / frontier | Done | `optimizer.ts`; `recommend.ts` |
| Black–Litterman, robust bootstrap, risk parity, max diversification, min CVaR | Done | `black-litterman.ts`, `recommend.ts`, `risk-strategies.ts` |
| Issuer / sector / rating / group / duration / DV01 constraints | Done | `exposure.ts` `buildConstraints` |
| Currency and maturity-bucket constraints | Missing | PR4: add as linear rows in `buildConstraints` |
| Long-only today | Done (implicit) | every `min` schema is ≥ 0 (`optimize-schema.ts`, `exposure.ts`); no explicit switch |
| `allowShortSelling`, short limits, gross/net exposure | Missing | PR5. Gross needs auxiliary variables; `solveGeneralQP` hard-codes Σx = 1 over every variable, so it gets a configurable budget row |
| Risk-free borrowing on the CAL | Extend | `recommend.ts` caps y* at 100% with a warning; no switch and no separate borrowing rate (PR5) |
| Analytic (short-allowed) bullet in the response | Extend | `recommend.ts` `unconstrained`: points only, but `tangency` holds weights. Under OFF it is labelled as a theoretical reference and its weights are dropped |
| Bond metadata | Extend | assets: coupon, maturity, face, frequency, day count, issuer; `credit` JSON: rating, agency, rating date, seniority, PD, LGD. Missing: issuer type, issuer country, callable, floating, identifiers, `riskFreeProxyEligible` (PR1) |
| Rf | Extend | `settings.riskFreeRate` with `rfSource`/`rfAsOf`; `settings.yieldCurve` {points, source, asOf} has no currency. There is no resolver: optimizer, bond credit and valuation editor each read settings directly (PR2) |
| Bond analytics | Done | `bonds.ts`: coupon schedule, accrued, clean/dirty, YTM, duration, convexity, key-rate, ±bp scenarios |
| Bond total-return series | Missing | optimizer uses close prices (price return) or `adj_close`; bond coupons are not added, so bond μ/σ from price only (PR3) |
| Bond expected return from yield/carry | Missing | bonds use historical/CAPM/blend like equities (PR4) |
| Saved optimizer preferences | n/a | none persisted server-side (UI state only), so "migrate to OFF" is the schema default |
| Rebalance | Done | `rebalance.ts` from target weights; PR5 adds a test that OFF targets never produce short sales |

**Baseline optimizer outputs (local data):** six objectives recorded before any change: max Sharpe, min variance, utility A = 4, max Sharpe + Rf, 40% cap, risk parity. Rf = 1.9% from settings and no yield curve is stored. They are re-run after PR2–PR5 to confirm the defaults reproduce them.

## PR8 — asset lifecycle

| Item | Status | Where / note |
|---|---|---|
| Asset master | Done | `assets` (id, unique symbol); single user, no shared master |
| Holdings "สินทรัพย์อื่น ๆ (ขายหมดแล้ว / ยังไม่ได้ซื้อ)" chips | Extend | `holdings/page.tsx`: `closed` (positions qty 0 with history) + `untouched` (no transactions), rendered as links only |
| Watchlist | Missing (absent) | no watchlist module; "Remove from Watchlist" is not offered, not invented |
| Hide / archive / delete | Missing | no asset delete anywhere (UI, REST, MCP) |
| **Cascade risk** | Risk | FKs: `transactions.asset_id` and `prices.asset_id` are **ON DELETE CASCADE**; `valuations`, `financial_statements` and `dividend_events` are SET NULL; `notes.asset_ids` is an array with no FK. A naive `DELETE FROM assets` would erase trades and prices, so deletion must check every dependency first in one transaction |
| Optimizer universe | Extend | `loadUniverse` takes every non-cash asset with enough prices; PR10 adds archived exclusion with a skip reason |
| Import | Extend | price import never creates assets; `add_asset` / createAsset by symbol |

## PR11 — scenarios and probabilistic valuation

| Method | Scenarios | Weighted value | Sensitivity | Reverse | Monte Carlo |
|---|---|---|---|---|---|
| FCFF/FCFE DCF (linear and staged) | Done (`scenarioAnalysis`, `stageOverrides`) | Done (`expectedValue`) | Done (`dcfSensitivity`, 5 axes) | Done for growth only (`impliedGrowthDetailed`) | Missing |
| Residual income (multi-stage) | Done (`rimScenarioAnalysis`) | Done | Done (Ke×ROE, Ke×g, ω, payout×ω) | Missing | Missing |
| DDM | Missing | Missing | Missing | Missing | Missing |
| Multiples | Missing | Missing | Missing | Missing (an implied multiple only) | Missing |
| SOTP | **Missing**: nested segment scenarios are ignored at the top level; output is one value (the PLANB #31 symptom) | Missing | Done (segment ±10%, holding discount grid) | Missing | Missing |
| Bond | ±bp price scenarios in `bonds.ts` (not probability-weighted) | Missing | Partly (yield shocks) | YTM from price is already "reverse" | Missing |

**Shared pieces to reuse:**
- `evaluate()` (single dispatcher) and `aggregateScenarios()` (probability rules, extracted in phase 1).
- `applyScenario()` / `applyRimScenario()` (allow-listed overrides) and `MODEL_VERSION` / `timestampFlags`.
- `saveValuation()` (persists assumptions and `result`).
- SOTP segments have no stable id (only optional `entity` and `name`). PR11 adds an optional `id`, falling back to `entity` and then `name`; duplicates are rejected.

## Order of work

Phase B: PR1 → PR2 → PR3 → PR4 → PR5. Phase C: PR6 → PR9. Phase D: PR10 + PR7. Then E1–E4: PR11/12 → PR13 → PR14 → PR15 → PR16. Each PR gets its own commit and gates.
