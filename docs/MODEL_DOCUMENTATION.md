# Investment Diary — Model Documentation

Model version: **2026.10-pr5** (`MODEL_VERSION` in `src/lib/governance.ts`). Every saved valuation stores the version it was computed with.
All rates in the engine are decimals (7% = 0.07). UI percentage fields take percentages (type 7 for 7%). Inputs that look like percentages entered as decimals produce a warning (`src/lib/rate-scale.ts`).

## 1. Portfolio ledger — `src/lib/finance/portfolio.ts`

| Item | Convention |
|---|---|
| Ordering | Transactions are applied by date, then by entry id. Duplicate ids are counted once |
| Cost basis | Average cost in THB. USD purchases are converted at the transaction FX rate |
| Sell | The quantity must be ≤ the holding. New entries are rejected (`OVERSELL`). Stored legacy rows sell only the held quantity, with proceeds and fee pro-rated, and raise a warning |
| Cash policy | `strict` (default): a buy or fee without enough cash is rejected. `infer_with_warning`: the shortfall becomes an explicit inferred external deposit. Legacy rows are never rewritten; shortfalls are shown as inferred deposits |
| Valuation | Last market price as of the date. Stale limits: stocks and gold 7 days, funds 10, bonds 30. With no market price the trade price is used and flagged. USD needs USDTHB; FX is never set to 1. A missing rate is flagged |
| Reconciliation | NAV = cash + Σ qty × price × FX; position and cash weights sum to 100% |

## 2. Performance — `returns.ts`, `metrics.ts`, `risk.ts`

| Measure | Formula / rule |
|---|---|
| TWR period return | Setting `twrFlowTiming`: start-of-day `V₁/(V₀+CF) − 1`; end-of-day `(V₁ − CF)/V₀ − 1`; Modified Dietz `(V₁ − V₀ − CF)/(V₀ + ½CF)` |
| Annualization | Cumulative is the headline when the period is under 365 days. `annualizedReturn` is null then, and `annualizedEquivalent` is labelled as extrapolated |
| XIRR | ACT/365. Scans (−99%, +1000%] for sign changes and bisects each bracket. Status `ok`, `no_sign_change`, `no_root` or `multiple_roots`; with multiple roots the rate is null |
| Periodic Rf | `(1 + Rf)^(Δdays/365) − 1` for each observation |
| N (periods/year) | Observations ÷ years of data (not a fixed 252) |
| Volatility, Sharpe, Sortino | σ×√N; `mean(r − rf)/σ(r − rf)×√N`; `mean(excess)×N / downside deviation`. Need ≥ 20 observations |
| Benchmark | Returns only between dates where the index has a real print. `benchmarkKind`: a price index excludes dividends (disclosed) |
| Beta / alpha | OLS of periodic excess returns, with standard errors and R². Jensen's alpha on annual rates is shown as an approximation. Beta is null when Var(benchmark) = 0 |
| IR / tracking error | `mean(active)×N / (σ(active)×√N)` |
| VaR / ES | Historical, ≥ 100 observations. ES averages the worst n(1 − c) observations, with a fractional boundary |

## 3. Equity valuation — `src/lib/finance/valuation.ts`

- Ke = Rf + β·ERP + premium. WACC uses the target D/(D+E) or market-value weights. Rf, ERP and beta carry a source and date (`inputMeta`). New valuations copy them from Settings and the estimated beta.
- FCFF = NOPAT + D&A − capex − ΔNWC. FCFE = net income − (capex − D&A) − ΔNWC + net borrowing. Interest is charged on opening debt. Borrowing policy: a fixed share δ of net reinvestment, or an explicit yearly schedule.
- Terminal value:
  - `gordon` — CFₙ(1+g)/(r − g). The implied reinvestment and ROIC are disclosed.
  - `stable_roic` — NOPATₙ₊₁(1 − g/ROIC)/(WACC − g); FCFE uses ROE.
  - `exit_multiple` — EV/EBITDA for FCFF, P/E for FCFE.
- Warnings when the terminal value is more than 70% or 80% of the total.
- Mid-year: explicit flows are discounted at t − 0.5 and a perpetuity terminal at n − 0.5. An exit multiple is discounted at n.
- Invalid inputs return errors and no value: r ≤ g, shares ≤ 0, tax outside [0,1], negative revenue, terminal ROIC ≤ 0.
- Sensitivity: rows are the discount rate; columns are g, terminal ROIC/ROE, margin, capex or δ. Invalid cells show N/A.
- Scenarios: Bear/Base/Bull overrides whose probabilities must sum to 1. Output is the expected value, range and σ.
- Reverse DCF: a constant growth rate is found by scanning and bisecting, with status `ok`, `no_root` or `multiple_roots`.
- DDM (Gordon, two-stage, H-model), residual income and justified multiples return no value when Ke ≤ g. Multiples record whether they are trailing or forward.

## 4. Optimizer — `optimizer.ts`, `recommend.ts`, `mpt.ts`

- Inputs: THB returns on dates where every asset has a price. μ = arithmetic mean × N. The covariance is the sample estimate or Ledoit–Wolf shrinkage. Both are checked for PSD (eigenvalue clipping with a warning) and conditioning.
- Bounds must satisfy n·min ≤ 1 ≤ n·max. Otherwise the result is `INFEASIBLE_BOUNDS` with a suggestion. Bounds are never relaxed.
- Exact active-set QP: `min wᵀΣw − λμᵀw`, with Σw = 1 and lo ≤ w ≤ hi. It reports status, KKT residual, |Σw − 1| and the largest bound violation.
- Target return: exact, on both arms of the bullet. Target risk: maximum return subject to σ ≤ target. Max Sharpe: golden-section search along the efficient arm. Typed errors when a target is infeasible or no portfolio beats Rf.
- With the risk-free asset, the objective is solved on the CAL. y > 1 (borrowing) or y < 0 is clamped and disclosed.
- The closed-form frontier with short sales is shown for comparison only. It is not investable when shorting is not allowed.

## 5. Bonds — `src/lib/finance/bonds.ts`

- The schedule is built back from maturity (or from the penultimate date) with an end-of-month rule. An issue date plus first coupon date gives a short or long first period. A date off the coupon cycle is `MALFORMED_SCHEDULE`.
- Discounting: CF/(1 + y/f)^t, with t in ICMA quasi-coupon periods. Accrued interest uses ACT/ACT-ICMA, ACT/365F, ACT/360 or 30/360. Ex-coupon periods give negative accrued interest. Amortizing principal is supported. Payment dates roll for weekends only.
- YTM, YTC (the bond's own coupons up to the call, plus accrued interest at the call), YTW, and horizon return (reinvestment rate and exit yield).
- Risk: Macaulay and modified duration, convexity, DV01, effective (±1bp) duration and convexity, and exact ±25/50/100bp reprices.
- Spot curve: zero rates with annual compounding and linear interpolation; price, Z-spread and key-rate durations.
- Portfolio bonds use the asset's stored frequency and day count. If these are missing, semi-annual ACT/ACT-ICMA is assumed and disclosed.
- Not supported: FRNs, holiday calendars, OAS.

## 6. Governance — `src/lib/governance.ts`

- Settings store the source, series and as-of date for Rf and ERP. Without a source the value is shown everywhere as illustrative.
- Valuation files can be exported and imported (`investment-diary/valuation` v1, with the model version). Older files get defaults for newer fields; malformed files are rejected.
- The data-quality report (`/data-quality`, `GET /api/v1/data-quality`, MCP `get_data_quality`, advisor tool) checks:
  - stale or missing prices and FX
  - illustrative market inputs
  - inferred deposits and NAV reconciliation
  - ledger issues
  - benchmark type and freshness
  - valuations saved under an older formula version
  - bonds without conventions

## 7. Validation

`npm test` runs unit, regression and end-to-end tests (`src/lib/e2e.test.ts`). The regression tests for each remediation PR were run first on the code before the fix and failed there. Reports are in `docs/validation/PR1_REPORT.md` … `PR5_REPORT.md`.
