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
| Split / reverse split | Transaction type `split` (migration 0009); quantity = new shares per old share (1:2 → 2; 10:1 → 0.1). Units × ratio, total cost unchanged (average ÷ ratio), no cash flow and no P&L. Earlier transactions are not rewritten. Recording one with no shares held is rejected; the same split twice is rejected. Cash for fractional shares is recorded as a separate sell |

## 1b. Market data — `src/lib/prices/yahoo.ts`, `src/server/services/price-sync.ts`

- `prices.close` is the provider close. For Yahoo this is split-adjusted but **not** dividend-adjusted (unchanged meaning since the first version). `prices.adj_close` (nullable, migration 0006) is the split- and dividend-adjusted series. It is stored only when syncing with `priceType: "adjusted_close"`; Yahoo rescales it retroactively after each new dividend.
- `syncHistoricalPrices` (MCP `sync_historical_prices`, `POST /api/v1/prices/sync`, holdings page) covers a date range (default 365 days, at most 3,660 days, at most 50 symbols) for assets already in the app. It also syncs the benchmark and USDTHB.
  - `overwriteExisting=false` never changes stored values, but it fills missing adjusted values. `dryRun` reports without writing.
  - Writes are idempotent because of the unique (asset, date) index.
  - Retries 3 times with exponential backoff. Results are per symbol, so one failure does not stop the others.
  - Unknown symbols are reported, not created. Manual assets are unsupported. SEC fund NAVs are fetched one day per request, so ranges are limited to 400 days or fewer.
  - Splits and dividends in the range are reported as warnings. Holdings are not adjusted for splits (no split transaction type yet).
  - After a sync it reports coverage (observations, largest gap, staleness) and optimizer eligibility from `loadUniverse` (the whole universe, filtered to the requested symbols).
- Bulk import `importPrices` (MCP `import_prices`, `POST /api/v1/prices/import` with a .csv/.xlsx file or JSON, holdings page) stores user-supplied prices through the same write path (source `import`), for any asset including manual ones.
  - Formats (`src/lib/prices/price-import.ts`, detected from the header; Thai or English): long `symbol,date,close[,adj close]`; wide `date,SYM1,SYM2,…`; a one-symbol export (Yahoo / Investing / SETSMART) with the symbol given separately.
  - Dates: ISO, day-first `DD/MM/YYYY`, Buddhist-era years (> 2400 → −543), Excel serials, month names. Thousands separators are accepted.
  - At most 50,000 rows. Lines that cannot be read are reported with their line number; future dates are skipped; for a date given twice the last row wins (with a warning). Unknown symbols are reported, not created.
  - Same keep/overwrite and dry-run rules as the sync. The web page always previews (dry run) before saving.
- Split price repair (`planSplitPriceRepair`, `record_split` / `POST /api/v1/transactions/split`, transactions page): compares the last close before the ex-date with the first close on/after it.
  - Within ±¼·|ln ratio| of the ratio (about ±19% for 2×): stored rows before the date (close and adj_close) are divided by the ratio.
  - Near 1: already adjusted (e.g. a Yahoo re-sync); nothing is changed.
  - In between: ambiguous; the user decides.
  - Idempotent; touches only that asset's prices; dry run first.
- Unrecorded splits: the data-quality check "แตกพาร์" flags day-to-day gaps within 8% of 2, 3, 4, 5, 10, 20 or their inverses on held assets with no split within ±7 days. These moves are impossible under SET's ±30% daily limit. Yahoo split events from a sync point to the same fix.
- The daily updater `updateAllPrices` uses the same functions incrementally (it re-fetches the last 5 days with overwrite).

## 1c. Return conventions (v3) — `src/lib/finance/return-series.ts`

- price_return = split-consistent closes, no dividends.
- total_return = provider adjusted closes **or** closes + per-unit distributions on ex-dates — never both (rejected).
- THB return = (1 + local)(1 + FX), with FX on the same date or ≤ 5 days earlier (flagged); THB assets are never converted; missing FX → unavailable.
- Series are aligned on common actual prints, compounding across gaps; there is no forward fill for assets, FX or the benchmark.
- β uses common actual asset/benchmark dates.
- Portfolio NAV/TWR (ledger) is unchanged and already includes income.
- Stored bond prices are treated as clean.
- See `docs/roadmap-v3/01_RETURN_CONVENTIONS.md`.

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
| VaR / ES 99% (v3) | `varTable`: 95% (≥ 100 obs) and 99% (≥ 250 obs; `reliable` only with ≥ 500). Horizon is one observation period; the √10 figure is labelled an i.i.d. approximation. See `docs/roadmap-v3/04_VAR_AND_BACKTEST.md` |
| VaR coverage backtest (v3) | `varBacktest` (`var-backtesting.ts`): rolling 250-period historical VaR, out of sample. Exceptions vs expected; Kupiec LR_uc ~ χ²₁; Christoffersen independence ~ χ²₁ only with ≥ 5 exceptions; conditional coverage ~ χ²₂. Needs ≥ 350 periods |

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
- Residual income, multi-stage (`model: "multi_stage"`, rows in `forecast` or parallel `roeForecast` / `epsForecast` / `payoutForecast` / `bookValueForecast`; `multi_stage` without yearly data is an error): yearly ROE or EPS, payout and optional stated book value; RIₜ = Eₜ − Ke·Bₜ₋₁ with clean surplus Bₜ = Bₜ₋₁ + E − D (a stated book value overrides it and the gap is flagged). Continuing value: perpetuity RIₙ₊₁/(Ke − g), persistence RIₙ₊₁/(1 + Ke − ω), or none. With constant ROE and g = ROE × retention it equals the single-stage formula (tested).

## 3b. Sum of the parts — `src/lib/finance/sotp.ts`, `method: "sotp"` in `valuation-schemas.ts`

- Each segment is valued 100% in its own currency by one of: an existing model (`dcf_fcff` EV or equity, `dcf_fcfe` equity, `ddm` / `residual_income` per share × segment shares, `multiples` per share × shares), metric × multiple (EV or equity), market price × shares, or a manual value that must name its source. It is then converted with `fx`.
- Roles: `division` (100%, part of the parent), `subsidiary` (consolidated), `associate` (equity method), `investment`.
- Debt treatment per segment (`debtAt`):
  - `parent` (default for a consolidated EV with a consolidated parent net debt): the EV is counted at 100%; the group's consolidated net debt and minority interest are deducted at the parent.
  - `segment`: equity₁₀₀ = EV − own net debt; attributable = ownership × equity₁₀₀.
  - When a consolidated segment carries its own net debt and the parent figure is consolidated, that net debt is added back to the parent figure so it is deducted once.
- Equity = Σ attributable − holding discount × (all segments or investments only) + non-operating assets − net debt (after add-backs) − minority interest − other claims − intercompany eliminations. Value per share = equity ÷ parent shares.
- Minority interest: given, or derived as (1 − ownership) × (EV − segment net debt) for partly owned segments counted at 100% EV.
- Double-counting controls:
  - Errors (no value): the same entity twice, a segment also listed as a non-operating investment, a consolidated equity value whose net debt cannot be removed from consolidated net debt, an EV of a non-consolidated segment without its own debt, an EV bridged at a holdco net debt that excludes its debt, a partly owned EV segment without minorities, a division under 100%, a failing sub-model.
  - Warnings: cash listed as a non-operating asset, minorities deducted for subsidiaries already counted at their ownership share, sub-model debt ignored under the parent treatment, control-vs-role mismatch, segment WACC using market weights.
- Output: segment table, waterfall, EV-to-equity reconciliation (difference must be 0), sensitivity (each segment ±10%, holding discount 0–40%). Saved valuations keep the assumptions plus the segment results and reconciliation at save time; reopening recalculates with the current engine.

## 4. Optimizer — `optimizer.ts`, `recommend.ts`, `mpt.ts`

- Inputs: THB returns on dates where every asset has a price. μ = arithmetic mean × N. The covariance is the sample estimate or Ledoit–Wolf shrinkage. Both are checked for PSD (eigenvalue clipping with a warning) and conditioning.
- Bounds must satisfy n·min ≤ 1 ≤ n·max. Otherwise the result is `INFEASIBLE_BOUNDS` with a suggestion. Bounds are never relaxed.
- Exact active-set QP: `min wᵀΣw − λμᵀw`, with Σw = 1 and lo ≤ w ≤ hi. It reports status, KKT residual, |Σw − 1| and the largest bound violation.
- Target return: exact, on both arms of the bullet. Target risk: maximum return subject to σ ≤ target. Max Sharpe: golden-section search along the efficient arm. Typed errors when a target is infeasible or no portfolio beats Rf.
- With the risk-free asset, the objective is solved on the CAL. y > 1 (borrowing) or y < 0 is clamped and disclosed.
- The closed-form frontier with short sales is shown for comparison only. It is not investable when shorting is not allowed.

- One engine: the analytics page (`getMptAnalysis`) and the legacy `mpt.ts` exports (`minVariancePortfolio`, `maxSharpePortfolio`, `efficientFrontier`, `meanVarianceOptimize`) now call the active-set QP in `optimizer.ts` with long-only bounds. The projected-gradient solver was removed. With no portfolio above Rf there is no tangency portfolio (null), instead of a "best negative Sharpe" point.

### 4a. Risk-aware constraints (v3)

- Per-asset bounds and linear constraints (issuer / sector / rating / custom groups, portfolio duration, DV01 in THB) go through a dual active-set QP (`solveGeneralQP`) inside the same λ pipeline.
- Box-only problems keep the original solver.
- Infeasible → `INFEASIBLE_CONSTRAINTS` with names; ES/turnover limits → `UNSUPPORTED_CONSTRAINT`.
- Groups come only from user metadata; unclassified assets are listed, never assigned.
- See `docs/roadmap-v3/03_RISK_CONSTRAINTS.md`.

### 4b. Black–Litterman — `black-litterman.ts`, `returnMethod: "black_litterman"`

- Prior: Π = δΣw_mkt (excess returns).
  - w_mkt is required for every asset (0 allowed) and is normalized. It is never taken from the user's holdings.
  - δ is given, or implied as ERP ÷ w_mktᵀΣw_mkt from the ERP setting.
- Σ is the covariance selected for the optimizer (sample or Ledoit–Wolf).
- Views:
  - Absolute: P row = eᵢ, Q = return − Rf.
  - Relative: equal weights within each leg, +1 long, −1 short; Q = outperformance.
- Ω = diag(((1 − c)/c) · pτΣpᵀ) for confidence c ∈ (0, 1], or an explicit variance per view. c = 0.5 is He–Litterman; c = 1 makes the view hold exactly.
- Posterior: μ = Π + τΣPᵀ(PτΣPᵀ + Ω)⁻¹(Q − PΠ), plus Rf. Σ_post = Σ + τΣ − τΣPᵀ(PτΣPᵀ + Ω)⁻¹PτΣ, used only when `posteriorCovariance` is set.
  - It equals the Theil mixed-estimation form (tested).
- Weights come from the existing `recommend` / QP with the same constraints. The output also gives the weights from the prior for comparison. With no views and no binding bounds, they equal w_mkt (tested).
- Not supported yet: sector / group limits. Assets have no sector field and the QP handles box and budget constraints only.

### 4c. Rebalancing proposals — `rebalance.ts`, `rebalance_portfolio`

- Targets come from `optimize_portfolio`, or are custom `{symbol: weight}` (the optimizer page pre-fills them from the optimizer and every cell is editable).
  - They are shares of (holdings + cash + extra cash − cash reserve). Whatever is not assigned stays in cash.
  - Held assets without a target are kept unless `sellUnlisted`.
- Holdings, cash, prices and FX come from the ledger snapshot (`buildSnapshot`). Stale or fallback prices are flagged.
- Costs (Settings → ต้นทุนการซื้อขาย, overridable per call):
  - commission = max(value × %, minimum); VAT on the commission
  - slippage = value × bps; sell tax on sells only
  - Lot size: per asset (`assets.lot_size`), else per asset class (default thai_stock 100), else 1.
- Solver (only what the QP cannot do):
  - The continuous ideal is rounded to whole lots: sells first, then buys by largest shortfall, each accepted only while cash after costs ≥ the reserve.
  - Then a best-improvement local search, one lot at a time (or a jump to the minimum trade size), under these constraints: no-trade band, minimum trade value, liquidity cap per symbol, turnover cap, no-sell option.
  - A 0% target means a full exit (odd lots included); the position is never added back.
- Score (return units):
  - track = ex-ante tracking error √((w − w*)ᵀΣ(w − w*)), using the optimizer covariance when all assets have history; otherwise the weight-gap norm
  - after_cost = TE + cost/total
  - min_cost = TE + 10·cost/total
  - min_turnover = TE + 0.1·turnover/total
  - These penalty weights are heuristic.
- Output: quantities, lots, values, the cost breakdown, totals, end cash, final vs target weights, TE before/after (plus the fractional-unit ideal), violations and warnings.
- **Proposals only — never written as transactions.**

### 4d. Risk decomposition, robustness, stress

- Risk contribution: MCTRᵢ = (Σw)ᵢ/σ, RCᵢ = wᵢ·MCTRᵢ, Σ RC = σ.
- Concentration: HHI and 1/HHI on weights and on risk shares.
- Component ES (historical): contributions over the portfolio's worst n(1 − c) observations, with the same fractional boundary as `expectedShortfall`. They sum to ES. Needs ≥ 100 observations.
- Robustness (`optimize_portfolio.robust`):
  - Bootstrap: resample dates with replacement → the same μ method (historical / CAPM β / blend / Black–Litterman) and covariance method → the same QP and constraints. Reports each weight's mean, sd, 5–95% range, how often it is held, the resampled-average weights, average turnover vs the base and failed draws.
  - μᵢ ± shock sensitivity.
  - A diagnostic, not a formal robust optimization.
- Stress (`stress_test_portfolio`):
  - equity: β × ΔR_m (bonds and cash excluded)
  - rates: −D_mod·Δy + ½C·Δy² from the bond analytics, or a duration override (funds)
  - FX: (1 + r)(1 + ΔFX) − 1 on USD assets
  - specific / group shocks, liquidity haircut by asset class
  - correlation: ρ' = ρ + k(1 − ρ) → σ and 1-day parametric 95% VaR
  - plus the worst historical day and 21-day window of the current weights
  - Sector shocks need a user-given group (no sector data). Preset sizes are illustrative and returned with the assumptions.

### 4e. Walk-forward backtest — `backtest.ts`, `backtest_portfolio`, `/backtest`

- Strategies: buy and hold, equal weight, minimum variance, max Sharpe, Black–Litterman, custom weights.
- Data:
  - Stored closes × USDTHB on a common calendar (dates where every chosen asset has a print; no forward fill).
  - The start is when all chosen assets have prices, or a given date (assets that start later are excluded and listed).
- At rebalance index t (every round(N/k) observations; k = 12, 4, 2 or 1 per year):
  - μ and Σ are estimated from the `window` returns that end at price t − 1 — no data from day t or later.
  - μ is historical, CAPM-β or blend; Σ is sample or Ledoit–Wolf; Black–Litterman is applied on top when chosen.
  - The weights come from the same `recommend` QP. When no portfolio beats Rf, minimum variance is used (disclosed).
  - Trades go through `rebalance` (fractional units, or lots) at the close of day t, with the Settings cost model.
- Between rebalances quantities are fixed; idle cash accrues Rf.
- Performance: `computeMetrics` on the value path. Capital is funded at the previous close, so first-day costs count.
  - TWR / CAGR, volatility, Sharpe, Sortino, max drawdown, VaR/ES
  - β, α, tracking error and IR vs the benchmark prints in the same window
- Added: turnover (total, per year, per rebalance) and cost attribution (commission, VAT, slippage, tax).
- Limitations (returned with every result):
  - Survivorship bias: only assets in the app today.
  - Closes exclude dividends.
  - Execution at the close; no dividend tax.
- Tested:
  - Buy-and-hold and daily equal-weight reference values.
  - Rf accrual and cost attribution.
  - Decisions unchanged when only future prices change.
  - The first trade after the window; bounds; Black–Litterman with no views equals the market weights.
  - Reproducibility.

## 5. Bonds — `src/lib/finance/bonds.ts`

- The schedule is built back from maturity (or from the penultimate date) with an end-of-month rule. An issue date plus first coupon date gives a short or long first period. A date off the coupon cycle is `MALFORMED_SCHEDULE`.
- Discounting: CF/(1 + y/f)^t, with t in ICMA quasi-coupon periods. Accrued interest uses ACT/ACT-ICMA, ACT/365F, ACT/360 or 30/360. Ex-coupon periods give negative accrued interest. Amortizing principal is supported. Payment dates roll for weekends only.
- YTM, YTC (the bond's own coupons up to the call, plus accrued interest at the call), YTW, and horizon return (reinvestment rate and exit yield).
- Risk: Macaulay and modified duration, convexity, DV01, effective (±1bp) duration and convexity, and exact ±25/50/100bp reprices.
- Spot curve: zero rates with annual compounding and linear interpolation; price, Z-spread and key-rate durations.
- Portfolio bonds use the asset's stored frequency and day count. If these are missing, semi-annual ACT/ACT-ICMA is assumed and disclosed.
- Not supported: FRNs, holiday calendars, OAS.

## 5b. Credit risk (v3) — `credit-risk.ts`

- All inputs are user-provided with source and date (PD type: hypothetical / historical / market-implied; LGD; rating, agency and date, else `unrated`). Missing → unavailable.
- 1-year EL = PD·LGD·EAD (not TFRS 9 ECL).
- PV(EL) = Σ marginal PD·LGD·EAD·DF over the payment periods; the credit-adjusted value is shown separately.
- Spread DV01 and spread duration come from bump-and-reprice on a supplied zero curve.
- Stress: a credit-spread shock combined with the rate shock in one repricing (2nd order, cross term in the credit line).
- See `docs/roadmap-v3/02_CREDIT_RISK_MODEL.md`.

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
