# PR 1 — Ledger & Performance Remediation (Phase A + B, P0)

Spec: `INVESTMENT_DIARY_FINANCIAL_MODEL_REMEDIATION.md` · Branch: `claude/vigilant-fermi-tf3wq7` · Baseline: `a1fee60`

Decisions taken with the owner:
- Scope: PR 1 only, then report before PR 2–5.
- Cash policy: **strict** for new entries; legacy rows are **flagged** (inferred deposits shown explicitly). No stored data was rewritten.

## 1. Summary

| Area | Before | After |
|---|---|---|
| Oversell | `Math.min` removed only the held qty but booked proceeds on the full sell qty → inflated realized P&L | New entry rejected (`OVERSELL`, REST 400 / MCP `isError`). Legacy rows: only the held qty is sold, proceeds & fee pro-rated, issue raised |
| Buy without cash | `spend()` silently created an implicit deposit | Strict: rejected (`INSUFFICIENT_CASH`). Legacy: explicit inferred external flow + warning, used as a contribution in TWR/XIRR |
| Same-day ordering | Re-ordered by transaction type | Date, then entry id (deterministic); duplicate ids counted once |
| Missing price / FX | Silently valued at last trade price; USD at `FX ?? 1` | `priceStatus` market / stale / tx_price_fallback / missing, `fxStatus`, stale limits per class (stock & gold 7d, fund 10d, bond 30d). FX = 1 never used; MPT/optimizer exclude USD assets without USDTHB coverage |
| Reconciliation | none | NAV = cash + Σ qty×price×FX, Σweights = 100%, recorded vs inferred contributions, status |
| Annualization | `< 1 year` returned the raw cumulative under the name `twrAnnualized` | `cumulativeReturn` primary; `annualizedReturn` = null under 1 year; `annualizedEquivalent` labelled *extrapolated* |
| Sharpe / Sortino / vol | CAGR − Rf over σ_daily×√252 | Periodic excess returns `rₜ − rf,ₜ`, `rf,ₜ = (1+Rf)^(Δdays/365) − 1`, N = observations per year from the data |
| TWR flow timing | implicit start-of-day | Setting: start_of_day (default) / end_of_day / Modified Dietz; zero bases skipped with an issue |
| XIRR | single Newton root | Bracket scan (−99%, +1000%] + bisection; status ok / no_sign_change / no_root / multiple_roots; residual; ACT/365 |
| Benchmark | forward-filled levels → zero returns on index holidays | Returns only between actual index prints; labelled *price index* (setting) |
| Beta / alpha / IR | beta = 0 on zero variance; Jensen only; IR mixed CAGR | beta null when undefined; OLS α, β with standard errors and R²; Jensen kept as "approx."; IR = mean(active)·N / (σ(active)·√N) |
| VaR / ES | shown on any sample | null below 100 observations; ES uses tail mass n(1−c) with fractional boundary |
| Ratios | always shown | null below 20 observations, `dataQuality` block with warnings |

## 2. Formulas (before → after)

- Realized P&L on sell: `qty_sell × price − fee − cost(min(qty_sell, held))` → `q = min(qty_sell, held)`, `proceeds = q × price − fee × q/qty_sell`, `realized = proceeds − avgCost × q`.
- Annual return: `cum` (when < 1y) → `annualized = (1+cum)^(365/days) − 1` only when days ≥ 365; else null + `equivalent` (extrapolated).
- Sharpe: `(CAGR − Rf)/(σ_d √252)` → `mean(rₜ − rf,ₜ)/σ(rₜ − rf,ₜ) × √N`.
- TWR period return: start `V₁/(V₀+CF) − 1`; end `(V₁−CF)/V₀ − 1`; Dietz `(V₁−V₀−CF)/(V₀+½CF)`.
- Regression: `(rp − rf) = α + β(rm − rf) + ε`, α_annual = α × N, SE from OLS residuals.

## 3. Numeric before / after examples

| Case | Before | After |
|---|---|---|
| Buy 10 @100, sell 11 @120 (legacy) | realized **320** | realized **200** + `OVERSELL` warning |
| Same via REST/MCP today | accepted | **400 OVERSELL** / `isError: true` |
| 182 days, +5% | "annualized" **5.00%** | cumulative **5.00%**, annualized **–**, equivalent 10.28% (labelled extrapolated) |
| Local seed portfolio (719 days) | — | TWR cum 26.66%, annual 12.74%, XIRR 12.88% (status ok, residual 1e-8), Sharpe 0.60 (N ≈ 260.4), β 0.39 ± 0.06, α 7.31% ± 13.88% (not significant) |

## 4. Changed files

- `src/lib/finance/portfolio.ts` — ledger replay, validation (`validateNewTransaction`, `LedgerError`, `LedgerIssue`), price/FX status, reconciliation, inferred flows.
- `src/lib/finance/returns.ts` — `xirrDetailed`, `periodReturns` (flow timing), `annualizeReturn`.
- `src/lib/finance/metrics.ts` — periodic excess-return metrics, benchmark alignment, OLS α/β with SE, data quality.
- `src/lib/finance/risk.ts` — nullable beta, VaR/ES minimum sample, ES tail mass.
- `src/db/schema.ts`, `drizzle/0004_pr1_conventions.sql` — settings `cash_flow_policy`, `twr_flow_timing`, `benchmark_kind`.
- `src/lib/validation.ts`, `src/server/services/settings.ts` — new settings, merge-on-save.
- `src/server/services/transactions.ts` — validate before insert.
- `src/server/services/portfolio.ts`, `src/server/services/optimizer.ts` — conventions passed through; no FX = 1.
- `src/server/api.ts` — `LedgerError` → 400 with `code`; `src/server/mcp.ts`, `src/server/openapi.ts` — tool docs.
- UI: `src/app/(app)/page.tsx`, `analytics/page.tsx`, `holdings/page.tsx`, `settings/page.tsx`, `actions.ts`, new `src/components/DataQuality.tsx`.
- Tests: new `src/lib/finance/ledger.test.ts` (16), `src/lib/finance/performance.test.ts` (19); `finance.test.ts` updated for the removed `annualizeByDates`.

## 5. Migration impact

`drizzle/0004_pr1_conventions.sql` only adds three `settings` columns with defaults (`strict`, `start_of_day`, `price_index`). No UPDATE/DELETE; transactions, prices and notes are untouched. Legacy inconsistencies are reported at read time (data-quality panel on dashboard / holdings), not corrected in the database.

Deploy: Vercel now runs `vercel-build` (`npm run db:migrate && next build`), so the Neon database is migrated before each build goes live. Manual alternative: `DATABASE_URL=<neon url> npm run db:migrate`.

## 6. Verification (actual results)

| Command | Result |
|---|---|
| `npx vitest run src/lib/finance/ledger.test.ts` on old code | 13 failed / 3 passed (16) — regression tests fail before the fix |
| `npx vitest run src/lib/finance/performance.test.ts` on old code | 18 failed / 1 passed (19) |
| `npm test` | 7 files, **95 passed** |
| `npm run lint` | No ESLint warnings or errors |
| `npx tsc --noEmit` | 0 errors |
| `npm run build` | success |
| `npm run db:migrate` (local Postgres) | applied; settings columns present |
| REST `POST /api/v1/transactions` sell 5,000 PTT holding 3,000 | 400 `OVERSELL` |
| REST buy beyond cash | 400 `INSUFFICIENT_CASH` |
| MCP `record_transaction` oversell | `isError: true`, row count unchanged |
| Legacy rows inserted directly (buy without cash + oversell) | holdings shows "2 คำเตือน · เงินฝากที่ระบบอนุมาน ฿367,457", NAV identity holds; rows removed afterwards |

## 7. Open issues (next PRs)

- PR 2 — DCF: terminal growth vs ROIC consistency, debt schedule, mid-year convention, assumption bounds.
- PR 3 — Optimizer: `projectBoxSimplex` silently relaxes infeasible bounds; move to a proper QP with feasibility reporting.
- PR 4 — Bonds: day-count / settlement conventions, accrued interest, clean vs dirty price.
- PR 5 — Assumption provenance (source / date for Rf, ERP, benchmark) and illustrative-default labelling across valuation pages.
- Not yet covered: corporate actions (splits, rights), total-return benchmark data source (setting exists, data still price index), multi-currency cash balances (cash is held in THB).
