# Roadmap v2.0 — Phase 0: Gap Analysis & Financial Validation

Repository state: branch `claude/vigilant-fermi-tf3wq7` (default and production branch; the only branch), HEAD `d58e6c4`.
Classification: **EXISTING** (works, keep) · **EXTEND** (exists, add capability) · **FIX** (exists, defect) · **NEW** (no implementation) · **DEFER** (not needed yet / dependency missing).

## 1. Existing feature inventory

| Capability | Status | Where |
|---|---|---|
| Historical price fetch (Yahoo daily close, incremental) | EXISTING → EXTEND (Phase 1) | `src/lib/prices/yahoo.ts` `fetchDailyCloses`; `src/server/services/price-updater.ts` `updateAllPrices` |
| Thai fund NAV (SEC, per day), Thai gold (GC=F × USDTHB), USDTHB, benchmark | EXISTING | `src/lib/prices/sec-th.ts`, `gold.ts`, `price-updater.ts` |
| Price store, no duplicates (unique asset+date) | EXISTING | `src/db/schema.ts` `prices`, `benchmark_prices`, `fx_rates`; `src/server/services/prices.ts` upserts |
| Portfolio ledger, cash policy, price/FX status, reconciliation | EXISTING (PR 1) | `src/lib/finance/portfolio.ts` |
| TWR (flow timing), XIRR (root status), annualization, Sharpe/Sortino (periodic excess), OLS beta/alpha, IR, VaR/ES | EXISTING (PR 1) | `returns.ts`, `metrics.ts`, `risk.ts` |
| Markowitz: exact active-set QP, GMV, target return/risk, max Sharpe, utility, bullet, CAL | EXISTING (PR 3) | `src/lib/finance/optimizer.ts`, `recommend.ts` |
| Expected returns: historical / CAPM / 50-50 blend, overrides | EXISTING | `src/server/services/optimizer.ts` `expectedReturns` |
| Covariance: sample, Ledoit–Wolf, PSD/conditioning diagnostics | EXISTING (PR 3) | `src/lib/finance/mpt.ts` `ledoitWolf`, `covarianceDiagnostics` |
| DCF FCFF/FCFE (stable ROIC, debt schedule, scenarios, sensitivity, reverse DCF), DDM, RI (single & multi-stage), multiples | EXISTING (PR 2, RI multi-stage) | `src/lib/finance/valuation.ts`, `src/lib/valuation-schemas.ts` `evaluate` |
| Bonds (schedules, day counts, YTC/YTW, curve, KRD) | EXISTING (PR 4) | `src/lib/finance/bonds.ts` |
| Saved valuations with model version, provenance, import/export | EXISTING (PR 5) | `src/server/services/valuations.ts`, `src/lib/governance.ts` |
| Data-quality report | EXISTING → EXTEND (history coverage) | `src/lib/governance.ts` `assessDataQuality`, `src/server/services/data-quality.ts` |
| MCP / REST / advisor surfaces | EXISTING | `src/server/mcp.ts` (24 tools), `src/app/api/v1/*`, `src/server/advisor.ts`, `src/server/openapi.ts` |

## 2. Gap analysis matrix

Columns: requirement → status · existing implementation · current limitation · required change · methodology · tests · acceptance.

### Phase 1 — Historical market data
| Req | Status | Existing | Limitation | Change | Method | Tests | Acceptance |
|---|---|---|---|---|---|---|---|
| `sync_historical_prices` tool | NEW (thin tool over extended service) | `updateAllPrices` | all assets only; no date range, no dry run, always overwrites; no per-symbol call | `syncHistoricalPrices()` service + MCP/REST/advisor | — | range resolution, dedupe, dryRun, idempotency | KBANK/BBL/AP/PLANB synced when they exist as assets; unknown symbols reported, not created |
| Date-range / backfill / incremental | EXTEND | `fromDate(last)` incremental | no end date; fixed 3-year backfill | `fetchDailyHistory(symbol, {from, to})` (period1/period2) | — | range tests | start/end honoured |
| Duplicate prevention, idempotent upsert | EXISTING (unique index) → EXTEND | `upsertPrice` per row, overwrite | no "keep existing", no counts | batched insert, on-conflict do nothing / update; counts | — | rerun ⇒ 0 inserted | no duplicates |
| Retry / rate limit / partial success | EXTEND | per-asset try/catch | no retry | 3× exponential backoff, per-symbol result | — | retry-then-success | partial results reported |
| Raw vs adjusted vs total return | FIX/EXTEND | stores Yahoo `close` (split-adjusted, not dividend-adjusted) | no dividend-adjusted series; meaning undocumented | additive nullable `adj_close`; `close` meaning unchanged and documented | Yahoo adjclose = split+dividend adjusted | close unchanged when adjusted requested | no change to existing rows' meaning |
| Corporate actions | FIX (report only now) | none | splits not applied to holdings | detect split/dividend events in range and warn; holdings adjustment DEFER (needs `split` transaction type) | — | split ⇒ warning | no synthetic data |
| Coverage / eligibility after sync | EXTEND | `loadUniverse` skipped reasons (MIN_OBS 60, common dates, USDTHB) | not reported after a sync | per-asset coverage + eligibility from `loadUniverse` | — | coverage helper tests | reasons per asset |
| Data quality: history | EXTEND | `assessDataQuality` | no history check | add "ประวัติราคา" check | — | governance test | listed in report |

### Phase 2 — SOTP
| Req | Status | Existing | Limitation | Change | Method | Acceptance |
|---|---|---|---|---|---|---|
| `method: "sotp"` in value_security/save_valuation | NEW (inside existing engine) | `evaluate` dispatch, `valuationInput` union | no composite method | add `sotp` schema: segments each `{ valuation: <existing method input> \| marketValue \| manualValue, ownership, basis: EV/equity, fx }` + bridge items | segment EV → equity via own net debt; attributable = ownership × equity; + associates, non-operating assets − holdco net debt − minorities − holding discount | value + bridge reconciliation; saved/reloaded |
| Double-counting controls | NEW | — | — | flags: cash/debt counted at segment and parent, consolidated subsidiary valued and also in parent EV, missing minority for <100% consolidated | error vs warning by severity | tests per case |
| Editor UI (segments, bridge, waterfall) | EXTEND `ValuationEditor.tsx` | method tabs | — | SOTP tab reusing method forms | — | save/edit/reload |

### Phase 3 — Optimization
| Req | Status | Existing | Change |
|---|---|---|---|
| Historical / CAPM / blend | EXISTING | `expectedReturns` | keep |
| Black–Litterman | NEW as `returnMethod: "black_litterman"` | `expectedReturns`, `optimize-schema.ts` | Π = δΣw_mkt (w_mkt supplied or from market caps — never defaults to the user's holdings); P, Q views (absolute/relative); Ω = diag(P τΣ Pᵀ)/confidence (He–Litterman/Idzorek-style, documented); posterior μ = [(τΣ)⁻¹ + PᵀΩ⁻¹P]⁻¹[(τΣ)⁻¹Π + PᵀΩ⁻¹Q] + Rf; output prior vs posterior; then existing `recommend` |
| Shared solver | FIX (duplicate engine found) | analytics page MPT uses the older projected-gradient functions in `mpt.ts` (`meanVarianceOptimize`, `maxSharpePortfolio`, `efficientFrontier`) while the optimizer uses the QP in `optimizer.ts` | move `getMptAnalysis` onto `optimizer.ts` functions; keep old exports only as wrappers |
| Sector / group limits | DEFER | assets have no sector field; QP supports box + budget only | needs `sector` on assets and a QP with general linear inequalities |

### Phase 4 — Rebalancing & risk
| Req | Status | Existing | Change |
|---|---|---|---|
| Cost-aware rebalancing (`rebalance_portfolio`) | EXTEND/NEW | `recommend().allocations` gives target value and trade in THB; ledger gives holdings and cash | new solver for lots, fees, minimum trade, cash constraint (proposals only, never recorded as transactions) |
| Risk contribution, MCTR, concentration | NEW (small) | `portfolioStats`, covariance | RCᵢ = wᵢ(Σw)ᵢ/σ_p; HHI / effective N |
| Component VaR | DEFER/NEW | `historicalVaR`, `expectedShortfall` | historical component ES via tail-scenario attribution |
| Robust: return sensitivity, bootstrap, weight stability | NEW using existing QP and LW | `recommend`, `ledoitWolf` | resample returns → re-optimize → weight distribution |
| Stress test (`stress_test_portfolio`) | NEW | betas (`loadUniverse`), bond durations (`bonds.ts`) | equity shock × β, rate shock × modified duration, FX shock, correlation shock via covariance; sector shocks DEFER (no sector data) |

### Phase 5 — Backtesting
| Req | Status | Existing | Change |
|---|---|---|---|
| Walk-forward engine (`backtest_portfolio`) | NEW | `recommend`, `estimateInputs`, `ledoitWolf`, `computeMetrics`, `buildValueSeries` concepts | rolling window estimate → optimize with data ≤ t → trade with costs → hold to next rebalance; metrics via `computeMetrics` |
| Survivorship bias | DEFER (disclose) | universe = current assets table | report limitation |

### Final phase
| Req | Status | Note |
|---|---|---|
| E2E tests | EXTEND `src/lib/e2e.test.ts` | add sync → universe → optimize path per phase |
| MCP contract tests | EXISTING `src/server/mcp.test.ts` | extend with each new tool |
| Tool discovery after deploy | EXISTING | `GET /api/v1/version`, MCP `get_server_info` |

## 3. Financial validation summary (Phase 0 scope)

Validated with independent references and regression tests in PR 1–5 (reports in `docs/validation/`), 183 tests passing at HEAD:
- Returns: TWR timing variants, annualization (no annualizing under 1 year), XIRR multi-root detection, benchmark alignment on actual prints.
- Risk: periodic-excess Sharpe/Sortino with N from data, OLS beta/alpha with SE, VaR/ES minimum sample and tail mass, zero-variance beta = null.
- Optimizer: bounds never relaxed, exact QP vs closed form / brute-force grid, CAL objectives, PSD repair.
- Valuation: DCF terminal and mid-year consistency, FCFF/FCFE reconciliation (MM), DDM/RI ke ≤ g → no value, multi-stage RI = single-stage under constant ROE.
- Bonds: 92.5613 reference, price↔yield round trip, stubs, day counts, YTC from schedule, KRD sum.
- Saving/reloading valuations: model version, defaults for old saves, import/export round trip.

Remaining items found in this review:
| Item | Classification | Impact | Plan |
|---|---|---|---|
| Stored `close` is Yahoo's split-adjusted close; ledger quantities are not adjusted for splits | FIX (detect + warn now) | after a split, market value of a held position is wrong until a split is recorded | Phase 1 warns on split events; split transaction type deferred |
| No dividend-adjusted / total-return price series | EXTEND | historical μ and covariance ignore dividends (understates returns of high-yield stocks) | Phase 1 adds optional `adj_close`; Phase 3/5 can choose it |
| Two optimizer code paths (analytics page vs optimizer) | FIX | analytics max-Sharpe can differ slightly from optimizer page | Phase 3 |
| Thai fund NAV history requires one API call per day | Limitation | long backfills are slow / rate-limited | Phase 1 caps range and reports |
| Rf is a single flat rate (no curve) | DEFER | maturity mismatch disclosed via provenance (PR 5) | — |
| No sector data on assets | DEFER | sector constraints and shocks impossible | add field when Phase 3/4 need it |

## 4. Dependency map

```
Phase 1 history sync ──► Phase 3 BL (needs covariance) ──► Phase 4 rebalance / robust / stress ──► Phase 5 backtest
        │                                                        ▲
        └──► data quality / universe eligibility ────────────────┘
Phase 2 SOTP — independent (valuation engine only)
Sector field (DEFER) ──► sector limits (P3) and sector shocks (P4)
Split transaction type (DEFER) ──► correct holdings through splits ──► backtest accuracy
```

## 5. Implementation plan (incremental, one commit/report per phase)
1. **Phase 1 (now):** `fetchDailyHistory` (range + adjclose + events), migration 0006 `adj_close`, `syncHistoricalPrices` service shared with `updateAllPrices`, MCP/REST/advisor `sync_historical_prices`, coverage + eligibility report, data-quality history check, holdings-page form, tests, report.
2. **Phase 2:** SOTP method in `valuation-schemas.ts` reusing `evaluate`; bridge + double-counting checks; editor tab.
3. **Phase 3:** Black–Litterman `returnMethod`; consolidate analytics MPT onto `optimizer.ts`.
4. **Phase 4:** `rebalance_portfolio`, risk contribution, bootstrap stability, `stress_test_portfolio`.
5. **Phase 5:** `backtest_portfolio` + page.
Each phase: tests first, lint/tsc/build, local MCP contract check, report in `docs/roadmap/`.
