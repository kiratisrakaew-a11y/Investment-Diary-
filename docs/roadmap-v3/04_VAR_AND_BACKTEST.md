# Phase 4 — VaR/ES 95/99, coverage backtests and backtest remediation

Status: IMPLEMENTED (v3 Phase 4)

## 1. VaR / ES table — `src/lib/finance/var-backtesting.ts` → `varTable`

- **Estimator:** reuses the existing `historicalVaR` and `expectedShortfall` from `risk.ts`, so there is no second estimator. ES uses the fractional tail boundary, as before.
- **Sign:** positive numbers are losses, as a fraction of portfolio value over **one observation period**.
  - With daily NAV the period is one trading day. `varHorizonDays` = 365 / N tells the actual calendar span.
- **Mean:** the sample mean is not removed. The figures are quantiles of observed returns.
- **Multi-day horizon:** `horizon.tenPeriodScaled` = √10 × the one-period figure.
  - It is labelled an approximation that assumes independent periods.
  - It is never measured from overlapping 10-day returns.
- **Minimum-observation policy:**

| Confidence | Minimum observations | Reliable flag |
|---|---|---|
| 95% | 100 (existing `MIN_VAR_OBS`) | yes, once available |
| 99% | 250 (about 2.5 tail points) | only with ≥ 500 observations |

- **Each row reports:** `observations`, `minRequired` and `tailObservations` = n(1 − c).
  - Below the minimum, VaR and ES are `null`, with the reason shown. Values are never extrapolated.
- **Backward compatibility:** the existing `var95` and `cvar95` fields are unchanged and still present. On local data they match `varTable[0]` exactly.

## 2. Coverage backtests → `backtestVaR(rs, c, window = 250)`

- **No look-ahead:** for each t ≥ window, VaR_t is estimated from returns t − window … t − 1 only. An exception is when −r_t > VaR_t.
- **Counts reported:** `exceptions`, `expected` = T·(1 − c), and `exceptionRate`.
- **Kupiec unconditional coverage:**
  - LR_uc = −2[ (T−x)ln(1−p) + x ln p − (T−x)ln(1−p̂) − x ln p̂ ], where p = 1 − c and p̂ = x/T.
  - LR_uc ~ χ²₁, with p-value = erfc(√(LR/2)).
  - The χ² quantiles 3.841 and 6.635 reproduce p = 0.05 and p = 0.01 to 4 decimals (test).
- **Christoffersen independence:**
  - Built from the first-order transition counts n00, n01, n10 and n11; LR_ind ~ χ²₁.
  - Computed **only** with ≥ 5 exceptions and both "previous = 0" and "previous = 1" states observed. Otherwise it returns `{ unavailable: reason }`.
- **Conditional coverage:** LR_uc + LR_ind ~ χ²₂, with p = exp(−LR/2).
- **Minimum sample:** window + 100 periods (350 by default). Shorter samples return `unavailable`.
- **Interpretation:** these are diagnostics.
  - Rejection means the historical model under- or over-states risk over the sample.
  - The model is never re-tuned to pass.

**Surfaces:** `computePerformance` → `varTable` and `varBacktest`. These appear on:
- the `/analytics` page (rows "VaR / ES 99%" and "Backtest VaR 95% / 99%");
- MCP `get_performance_metrics` and the REST performance endpoint (same object; the description was updated);
- the advisor (same service).

Local check (514 daily periods, 2024-11-06 → 2026-10-27):

| | VaR | ES | Exceptions / expected | Kupiec p | Christoffersen |
|---|---|---|---|---|---|
| 95% | 2.06% | 2.59% | 13 / 13.2 | 0.955 | p = 0.245 |
| 99% | 3.00% | 3.21% | 4 / 2.6 | 0.434 | unavailable (4 exceptions) |

## 3. Tests — `var-backtesting.test.ts` (6)

All tests use synthetic seeded normals and no market data.
- Reuse of the existing estimators; 99% ≥ 95%; ES ≥ VaR; normal-theory values 1.645σ and 2.326σ.
- Minimum-observation policy: 200 → 99% null; 300 → available but unreliable; 1,000 → reliable.
- χ²₁ survival at known quantiles; Kupiec LR equals the hand formula.
- Calibration:
  - i.i.d. data is not rejected.
  - A tripled-volatility regime is rejected with p < 0.01.
  - Clustered exceptions fail the independence test.
  - Short samples are unavailable.

## 4. Backtest remediation (walk-forward `backtest_portfolio`)

| Item | Status |
|---|---|
| FIX-1: slow fractional backtest (baseline timeout of 5.1 s) | FIXED. `rebalance()` has a `fractional` fast path that scales all buys together, with a bisection so cash covers costs. Used when `useLots = false`. The test now runs in ~18 ms and asserts < 1.5 s. Lot-based runs keep the exact lot search |
| FIX-2: benchmark forward-fill | FIXED in Phase 1 (`alignWithBenchmark`) |
| Dividends | Optional `returnBasis: "total_return"`, which uses provider `adj_close` (reinvested on the XD date). Rejected together with `useLots` (an adjusted price level is not a tradable price). Without adj_close it returns a typed unavailable |
| Bond coupons | Not included (clean prices). Disclosed in `limitations` |
| Survivorship | Always disclosed. The result never claims to be survivorship-free |
| Look-ahead audit | Weights at each rebalance use only data up to that date. Remaining known look-ahead: Black–Litterman market weights are today's values (disclosed). Provider adj_close levels are revised retroactively, but the ratios between dates use no future information (disclosed) |
| Costs | Trading costs and lot size come from Settings, and slippage is applied at the rebalance close |

## 5. Limitations

- Historical VaR assumes the sample window represents the future. It reacts slowly to volatility regime changes, and the backtest exposes this.
- With about 2 years of daily NAV, the 99% backtest has only ~2.6 expected exceptions. Kupiec has low power here, so "not rejected" is weak evidence.
- NAV-based returns include the effects of trade timing and flows, measured by TWR.
- These figures do not report VaR for a hypothetical static portfolio. Use the stress test (`historicalWorst`) for that.
- Basel traffic-light zones are not reported. They assume 250 daily observations at 99% for a bank trading book, and the app does not fit that use.
