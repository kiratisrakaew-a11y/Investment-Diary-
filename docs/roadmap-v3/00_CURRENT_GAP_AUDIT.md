# Phase 0 — Current-code gap audit (v3 spec)

Audited: `claude/vigilant-fermi-tf3wq7` @ `1c0ab342f2e184553c1c13dd57291721598c551b` (2026-10-27). Baseline commands: `00_BASELINE_TEST_RESULTS.md`.

## A. Confirmed defects (reproduced on the old code)
| ID | Defect | Evidence | Fix phase |
|---|---|---|---|
| FIX-1 | The fractional-unit backtest with trading costs is extremely slow and its search may stop before converging. | `npm test` fails: timeout at 5,000 ms. `backtest.ts:177` passes `lot: 1e-6` to `rebalance()`; `rebalance.ts:232–234` runs a one-lot local search capped at 5,000 iterations. | 4 |
| FIX-2 | The benchmark is forward-filled onto the asset calendar with `asOf`, which creates artificial zero benchmark returns and biases β and the CAPM expected return. A benchmark that starts after the window gives `asOf → 0` → Infinity, so β is silently dropped. | `services/optimizer.ts:124` `simpleReturns(dates.map(d => asOf(bench, d) ?? 0))`; same pattern in `backtest.ts` (`benchAt`). Repro with 3 missing index days: 3 zero returns; β = 1.412 against a true 1.5. | 1 |

## B. End-to-end trace (stock and bond)
**Stock (THB or USD)**
- Prices: `prices.close` is the Yahoo close, split-adjusted but not dividend-adjusted. `prices.adj_close` is filled only when synced with `priceType: adjusted_close`.
- Holdings: `buildSnapshot` / `buildValueSeries` (`portfolio.ts`) give qty × close × FX. Dividends are ledger `dividend` transactions added to cash, so the **portfolio NAV / TWR is total return**. `split` multiplies the quantity.
- Analytics returns:
  - `loadUniverse` gives simple returns of close × FX on the dates where all assets have a print. This is a **price return**: dividends are excluded and the basis is not labelled.
  - FX is applied multiplicatively (p·fx / p₋₁·fx₋₁ = (1+r_local)(1+r_fx)), but FX is forward-filled with `asOf`.
  - The benchmark is forward-filled (FIX-2).
- `metrics.ts computeMetrics` works on the NAV series. Benchmark returns are taken only between actual prints (correct). VaR/ES are 95% only, one period.
- The optimizer and robust module use `loadUniverse` series; `riskContribution` and `componentES` use 95% only.
- `backtest.ts` uses closes, i.e. price return (disclosed). Its CAPM β uses the forward-filled benchmark (FIX-2).
- `stress.ts`: equity shock × β, FX compounded.
- UI/API/MCP: performance, optimizer, backtest and stress pages; `get_performance_metrics`, `optimize_portfolio`, `backtest_portfolio`, `stress_test_portfolio`.

**Bond**
- The stored price is a per-unit price entered by the user. `bondHoldings` converts it to per-100 and **treats it as clean**; this is not labelled in storage.
- Coupons are ledger `coupon` transactions credited to cash, so they are in NAV.
- `analyticsFromPrice` gives YTM, duration, convexity, accrued interest and the dirty price. `priceFromCurve` / `zSpread` / `keyRateDurations` accept a spread.
- Returns in the universe and backtest are the clean price only (no coupons, no accrued interest).
- Stress rate shock: −D·Δy + ½C·Δy². There is no credit spread, no credit data, no issuer and no rating field.

**Provenance:** Rf/ERP source and date live in settings, and valuations store `modelVersion`. Price rows have no `availableAt` / publication timestamp, so point-in-time is not supported.

## C. Requirement matrix
| Requirement | State | Code path | Gap | Change | Duplication risk | Test | Priority |
|---|---|---|---|---|---|---|---|
| Canonical return series (price vs total, FX, provenance) | EXTEND | `loadUniverse`, `backtest`, `stats.simpleReturns` | No shared policy; price basis unlabelled; benchmark forward-fill (FIX-2) | Pure `return-series.ts`; adopt in `loadUniverse` / backtest | Low: one helper; ledger NAV untouched | Dividends raw vs adj, split, FX, alignment | P0 |
| Total-return option for analytics and backtest | NEW (data-limited) | `adj_close` stored but unused | Needs adj_close coverage; per-share dividends not stored | Use provider adj_close when complete, else typed `unavailable` | Do not combine adj_close with dividends | No double count | P0 |
| Bond clean/dirty basis, coupons in returns | EXTEND / DEFER | `bonds.ts`, `bondHoldings` | Stored basis implicit | Label clean basis; bond analytic returns stay price-only, disclosed; coupons stay in ledger NAV | — | Label test | P0 |
| Credit PD/LGD/EL, survival, PV(EL) | NEW | none | — | `credit-risk.ts` (pure); per-asset credit profile (user-sourced) | None | Hand calculations | P0 |
| Spread DV01 / spread duration | EXTEND | `bonds.ts` `priceFromCurve(spread)`, `zSpread` | Not exposed | Bump-and-reprice using the existing functions, only with a user curve | Reuse pricing | ±1bp symmetry | P0 |
| Credit-spread stress | EXTEND | `stress.ts` | No spread factor | `creditSpreadShockBp` global / per symbol; combined with rates once (2nd order, disclosed) | One stress engine | Legacy payload unchanged | P0 |
| Issuer / sector / rating metadata | NEW | assets table (none) | — | Additive columns, user-entered with source/date | — | Missing → unclassified | P1 |
| Linear constraints (issuer/sector/bucket caps, duration limit, per-asset bounds) | NEW | `solveBoxQP` (box + budget only) | QP cannot take Aw ≤ b | General-constraint QP behind the same λ pipeline, used only when constraints are given | Box path unchanged | KKT / feasibility / infeasible | P1 |
| ES / turnover constraints | NOT SUPPORTED | — | Nonlinear | Return `UNSUPPORTED_CONSTRAINT` | — | Test | P1 |
| VaR/ES 95% & 99%, horizon | EXTEND | `risk.ts` (c is a parameter), `metrics.ts` (95% only) | 99% and horizon labels missing | Extend metrics; 99% min-obs policy | Same algorithm | Two levels | P1 |
| VaR coverage backtest (Kupiec, Christoffersen) | NEW | none | — | `var-backtesting.ts` | — | Synthetic calibration | P1 |
| Backtest: dividends, coupons, look-ahead, costs, survivorship | FIX / EXTEND | `backtest.ts` | FIX-1, FIX-2; price-only; static BL weights look-ahead undisclosed | Fractional fast path; aligned benchmark; total-return basis via the Phase-1 helper; disclosures | Reuse rebalance and computeMetrics | Dividend, split, no look-ahead, speed | P1 |
| Monte Carlo DCF | DEFER (Phase 5) | `valuation.ts` scenarios exist | — | Not implemented without a verified use case (spec §7) | — | — | P2 |
| Risk parity / budgeting | DEFER (Phase 5) | `risk-contribution.ts` | — | Same | — | — | P2 |
| OAS, FRN, optionality, premium feeds | DEFER (Phase 6) | `bonds.ts` (fixed coupon; YTC/YTW only) | — | Not implemented; fixed-bond duration is not OAS | — | — | DEFER |
| Already present, verified | EXISTS | Historical VaR/ES 95%; YTM/duration/convexity/Z-spread/KRD; SOTP; BL; rebalance; risk contribution; robust; stress; backtest; splits | — | Not recreated | — | Existing tests | — |

## D. Unverified risks (not claimed as defects)
- FX is forward-filled with `asOf` in `loadUniverse` and the backtest; with daily FX the impact is expected to be small (to be covered by the Phase 1 alignment policy).
- `adj_close` levels are rescaled by Yahoo after each dividend. Ratios between dates are unaffected (no look-ahead in returns), but levels are not point-in-time.
- Stored bond prices are assumed to be clean per unit; nothing enforces this.
