# Phase 1 — Shared return / cash-flow conventions

Module: `src/lib/finance/return-series.ts` (pure, no DB/network).

| Rule | Implementation |
|---|---|
| One canonical selection | `buildLevelSeries({ observations, basis, totalReturnSource?, distributions?, currency, fx })` returns THB index levels per actual print, or a typed `{ ok: false, status: "unavailable" \| "invalid", reason, required }` |
| price_return | Split-consistent closes; distributions are never added (a warning is given if some are passed) |
| total_return | `adjusted_close` (provider series) **or** `distributions` (closes + per-unit cash on ex-dates, counted once in (t−1, t]). Both together → `invalid` (double counting). Missing adj_close → `unavailable` with the required action |
| FX | 1 + R_THB = (1 + R_local)(1 + R_FX), FX on the same date or the last fixing ≤ 5 days earlier (counted and flagged). THB assets are never converted. No FX → `unavailable` (never FX = 1) |
| Calendars | `commonDates` = intersection of actual prints; `returnsOn` compounds across gaps; `alignWithBenchmark` uses common actual dates of asset and benchmark. **No forward fill** (fixes FIX-2) |
| Ledger / NAV | Unchanged. Portfolio TWR already includes dividends and coupons as cash; analytic return indices are kept separate (no phantom flows) |
| Bonds | The stored per-unit price is treated as **clean** (`bondHoldings.priceBasis = "clean_assumed"`); analytics add accrued interest for the dirty price. Analytic bond return series are price-only (coupons excluded, disclosed); coupons count once, through the ledger in NAV. A clean→dirty bond total-return series needs coupon schedules per date — not done (no change to existing results) |
| Provenance / point in time | `provenance.priceField` (close / adj_close), `incomeFromDistributions`, FX policy and coverage. Price rows have no `availableAt`, so results are **not point-in-time**; adj_close levels are rescaled by the provider, but period returns use no future data |

## Adopted in
- `loadUniverse` (optimizer, robust, stress, risk contribution): levels per asset → common calendar → returns. β is taken on common actual asset/benchmark prints. New option `returnBasis` (default `price_return`, unchanged results); `optimize_portfolio.returnBasis`.
- Backtest: the CAPM β window uses benchmark prints before the trade date only (no forward fill). The service builds THB prices through the helper; new `returnBasis` (`total_return` = provider adjusted closes, dividends reinvested; lots disabled; disclosed).
- Not changed: `computeMetrics` (it already uses actual benchmark prints), ledger, valuation.

## Tests
- `return-series.test.ts` (14): dividend raw+distribution hand calculation vs adjusted close; double-count rejection; sparse dates count a dividend once; split neutrality; USD (1.02 × 1.02); THB ignores FX; stale/missing FX; FIX-2 regression (old method: 3 zero returns, β 1.412 vs true 1.5; new: no zeros, β ≈ 1.5); typed errors.
- `return-conventions.test.ts`: the same price history gives an identical return through the helper, the backtest (buy and hold) and the ledger NAV TWR (`computeMetrics`).
- `backtest.test.ts`: benchmark no-look-ahead / gaps for CAPM.

## Local verification
- The optimizer (price_return) gives the same β as before (e.g. CPALL 1.166, PTT 1.024; the local benchmark has full prints).
- Equal-weight backtest +25.08% (unchanged).
- `total_return` without adj_close returns the typed reason for each asset ("sync_historical_prices ด้วย priceType: adjusted_close").
