# Financial model audit (Phase 0)

- **Branch:** `claude/vigilant-fermi-tf3wq7`
- **HEAD audited:** `dc7de23b826466a4e3db991879eb3f02a0fdde34` (same as origin, clean tree)
- **Date:** 27 Oct 2026
- **Scope:** every financial engine listed in the hardening specification. No source code was changed in this phase.

## Baseline (commands actually run)

| Command | Result |
|---|---|
| `npx vitest run` | 53 files, 545 tests passed (exit 0) |
| `npx tsc --noEmit -p .` | exit 0 |
| `npm run lint` | no warnings or errors |
| Independent numerical check (scratchpad script `audit/verify.mts` + `audit/lw.py`, numpy 2.5.3 reference) | 31 hand / reference cases. All pass except the stress case below (**S-1**) |

Notes:
- `CLAUDE.md` does not exist in the repository; `README.md` and `docs/` were read instead.
- `var-backtesting.ts` exists. The specification's file list omits `return-series.ts`, `metrics.ts` and `returns.ts`; all of them exist.

### Independent reference cases

Expected values were computed by hand or with numpy, never by calling the function under test.

| Case | Expected | Actual | Tolerance | Result |
|---|---|---|---|---|
| Historical VaR 95%, r = (i − 50)/1000, i = 1..100 (type-7 quantile) | 0.04405 | 0.04405 | 1e-9 | pass |
| ES 95%, same sample (mean of the 5 worst) | 0.04700 | 0.04700 | 1e-9 | pass |
| TWR start-of-day: V₀ 100, flow +100, V₁ 220 | 0.10 | 0.10 | 1e-9 | pass |
| XIRR: −100 on 2025-01-01, +110 on 2026-01-01 | 0.10 | 0.10 | 1e-9 | pass |
| Sharpe / Sortino / CAGR / MDD / Calmar on a 400-day synthetic path, Rf 0 | 6.36036 / 13.50926 / 1.46242 / 0.005 / 292.485 | identical | 1e-9 | pass |
| 2-asset E[R] and σ (w = 0.6/0.4) | 0.096 / 0.177989 | identical | 1e-9 | pass |
| Ledoit–Wolf (2004) δ, Σ₀₀, Σ₀₁ vs numpy | 0.0339499 / 0.0882993 / 0.0716363 | identical | 1e-12 | pass |
| 5y 3% semi-annual bond at 4%: price, Macaulay, modified duration, convexity, DV01 | 95.508707 / 4.671065 / 4.579476 / 24.12873 / 0.043738 | identical | 1e-6 | pass |
| Accrued interest, ACT/ACT-ICMA, 92 of 183 days | 0.754098 | 0.754098 | 1e-9 | pass |
| Hold to maturity, reinvest 0: future value | 115 | 115 | 1e-9 | pass |
| Hold to maturity, reinvest = YTM: annualized return | 0.04 | 0.04 | 1e-9 | pass |
| +100 bp: duration + convexity approximation vs full repricing | full −4.4611% | approx −4.4588% (error +0.0023 pp) | — | reported, not an error |
| Ex-coupon settlement, 10-day horizon (exCouponDays 10 vs 0) | ~equal | 0.10857% vs 0.10750% | — | consistent |
| CAPM, WACC, Gordon, two-stage DDM, single-stage RIM, justified P/BV = RIM / B₀ | hand | identical | 1e-9 | pass |
| FCFF DCF, 1 year + Gordon terminal, target weights (hand bridge) | hand | identical | 1e-9 | pass |
| Monte Carlo sd(X + Y), U(0,1) marginals, independent / ρ = 0.8 / ρ = −0.6 | 0.4082 / higher / lower | 0.4145 / 0.5540 / 0.2658 | sampling (n = 4000) | pass (ordering correct) |
| **Stress: long-only position, β 1.8, equity −60%** | position loss ≤ 100% | **P&L −108, NAV after −8, no warning** | — | **fail (S-1)** |

## Classification legend

`CONFIRMED_BUG` · `METHODOLOGICAL_LIMITATION` · `UI_INTEGRATION_GAP` · `DATA_QUALITY_ISSUE` · `UNVERIFIED_CONCERN` · `NO_CHANGE_REQUIRED`

Capability status: `EXISTS_AND_WORKS` · `EXISTS_BUT_NEEDS_FIX` · `BACKEND_ONLY` · `NOT_IMPLEMENTED`

---

## 1. Returns and portfolio performance

**Status: EXISTS_AND_WORKS.** One data-quality issue: D-1.

| Item | Location | Formula / convention | Finding |
|---|---|---|---|
| Simple return | `stats.ts:40` `simpleReturns` | Pₜ/Pₜ₋₁ − 1. Pairs with Pₜ₋₁ ≤ 0 are dropped. | NO_CHANGE. The one caller (`services/portfolio.ts:141`) passes a common-date series of positive prices, so nothing is dropped and the series stay aligned. |
| Log return | — | Not used anywhere; no mixing of conventions. | NO_CHANGE |
| TWR | `returns.ts:107` `periodReturns` | Start-of-day V₁/(V₀+CF) − 1 (default), end-of-day, or modified Dietz (labelled as an approximation). Linked geometrically. | NO_CHANGE. A period whose base is ≤ 0 is skipped and reported. The wealth index then carries 0 for that period (`metrics.ts:151`); this only happens when NAV is zero, i.e. no capital is at risk. Documented here. |
| XIRR | `returns.ts:33` | Root of Σ CF·(1+r)^−t (ACT/365), with a full scan. | NO_CHANGE. Multiple roots are reported, not picked. |
| CAGR | `returns.ts:161` `annualizeReturn` | (1+R)^(365/days) − 1, shown as annualized only when the period is ≥ 1 year. | NO_CHANGE |
| Arithmetic annual return | `metrics.ts:254` | mean(r) × N, with N = observations per year measured from the data. | NO_CHANGE (labelled arithmetic) |
| Dividends / coupons | ledger replay (`portfolio.ts`) | Valuation uses unadjusted `close`; dividends and coupons enter as cash transactions. | NO_CHANGE. There is no double count with adjusted prices because `adj_close` is not used for NAV. |
| Missing prices | `portfolio.ts:382` `priceInfo` | As-of (last) price, flagged `stale` / `tx_price_fallback` / `missing` in the snapshot. | See D-1 |
| FX | `portfolio.ts:398` | As-of USDTHB, else the trade-date FX. Never 1. | NO_CHANGE |

**D-1 · DATA_QUALITY_ISSUE (P1). Mixed-calendar valuation dates in the performance series.**
- *Root cause:* `services/portfolio.ts:71` `valuationDates` takes the union of every asset's price dates plus benchmark and trade dates. `buildValueSeries` then values each holding at its last available price. With Thai and US holdings, an SET holiday that is a US trading day gives the Thai legs a 0% day followed by a two-day move. The same happens to any illiquid asset.
- *Unaffected:* TWR, CAGR and XIRR, because the wealth path is the same.
- *Affected:*
  - the distribution of periodic returns, and therefore volatility, Sharpe, Sortino, VaR / ES and backtest exception timing;
  - serial correlation;
  - the observation count N.
- *Local data:* all six traded assets share the same 514 dates, so the effect is 0 locally. It cannot be measured on production data from here.
- *Proposed fix:*
  - compute the risk statistics on the wealth index sampled at **synchronised dates** (dates where every held position has an actual print), linking returns across skipped dates. TWR and XIRR are unchanged.
  - report the count of carried prices in `dataQuality`.

## 2. VaR, ES and backtesting

**Status: EXISTS_AND_WORKS** for one-period historical VaR and ES. Multi-horizon is **NOT_IMPLEMENTED**: only a labelled √10 approximation exists.

| Item | Location | Definition | Finding |
|---|---|---|---|
| Historical VaR | `risk.ts:47` | VaR_c = max(0, −Q₁₋c(r)), with type-7 interpolated quantile, return-based, positive loss, one observation period, ≥ 100 observations | Correct; verified by hand. The floor at 0 means a sample whose 5% quantile is a gain reports VaR 0. This is a METHODOLOGICAL_LIMITATION to document, not a bug: VaR is defined here as a loss amount. |
| ES | `risk.ts:56` | Mean of the worst n(1−c) observations, with a fractional boundary observation | Correct (Acerbi–Tasche discrete estimator). ES ≥ VaR holds for this pair of estimators. NO_CHANGE. |
| VaR table 95 / 99% | `var-backtesting.ts:28` | Minimum 100 / 250 observations; 99% flagged unreliable below 500 | NO_CHANGE |
| 10-period VaR | `var-backtesting.ts:44` | √10 × the one-period value, labelled as an i.i.d. approximation | METHODOLOGICAL_LIMITATION (already labelled) |
| Horizons of 1 month, 1 year, 3 years and 5 years | — | — | **NOT_IMPLEMENTED (H-1)** |
| Backtest | `var-backtesting.ts:93` | Rolling window of 250 using data before t only (no look-ahead); Kupiec LR_uc χ²₁; Christoffersen LR_ind χ²₁ with ≥ 5 exceptions; conditional coverage χ²₂ | Verified by reading the code; formulas are standard. NO_CHANGE. |
| Monetary VaR | UI shows percentages | — | UI_INTEGRATION_GAP (P2): add THB = VaR × NAV, labelled |
| UI label | `analytics/page.tsx:49` labels the export "VaR_1วัน" | The real horizon is one observation (≈ `varHorizonDays`) | UI_INTEGRATION_GAP, minor: relabel as "1 งวด" |

**H-1 · NOT_IMPLEMENTED (P0 per spec §5.2).**
- *Proposal:* historical multi-period VaR / ES from compounded returns R_H = Π(1+rₜ) − 1 over a window of h observations. Report two variants, labelled differently:
  - non-overlapping windows — independent, but few samples;
  - overlapping windows — more samples, but autocorrelated; flagged.
- Horizons: 1, 10, 21 (≈ 1 month), 252 (1 year), 756 (3 years) and 1,260 (5 years) observations.
- Minimum-sample rule: below it the horizon is "unavailable — not enough history". With about 2 years of data, 1-year VaR on non-overlapping windows will be unavailable, and that is the honest result.
- Because R_H is compounded from rₜ ≥ −1, a long-only unlevered portfolio cannot lose more than 100%; no clamping is needed.
- No bootstrap is added. The spec allows it, but nothing requires it; it can be added later as a separate, labelled method.

**S-1 · CONFIRMED_BUG (P0). Stress test can lose more than 100% of a long-only position.**
- *Location:* `stress.ts:58` and `stress.ts:86`. `local = β·ΔR_m + rate + credit + specific` is linear and has no bound.
- *Reproduction:* β 1.8, equity −60% → position P&L −108 on a value of 100, NAV after = −8, no warning. Combining a −50% specific shock with a −60% market shock does the same.
- *Fix:*
  - keep the linear sensitivities;
  - report the linear figure as `linearReturn`;
  - floor the position return at −100% for long positions, with a warning that names the position and says the linear β / duration approximation is outside its valid range. The total uses the floored value.
  - This is not a silent clamp: both numbers and the warning are returned. The ledger does not hold short positions or leverage, so this bound always applies to recorded holdings.

## 3. Valuation Monte Carlo

**Status:** the engine (`valuation-montecarlo.ts:146`) EXISTS_AND_WORKS. Correlation support in the UI is **BACKEND_ONLY**.

| Item | Finding |
|---|---|
| Seed reproducibility, marginals, invalid-draw accounting, time budget | NO_CHANGE. Covered by existing tests. |
| Copula correlation | Verified: sd(X+Y) is 0.554 / 0.414 / 0.266 for ρ = 0.8 / 0 / −0.6. NO_CHANGE in the engine. |
| `prepareCorrelation` (`:82`) | Repairs a non-PSD matrix automatically (clip, then rescale to unit diagonal) and adds a warning. The engine's behaviour is fine; the UI must ask before running on a repaired matrix (M-1). |
| **M-1 · CONFIRMED_BUG (UI, P0)** | `ScenarioWorkbench.tsx:600 / 645 / 656` set `correlation: undefined` on **any** variable edit, including a change of distribution parameter. A correlation matrix saved through API or MCP is therefore silently deleted the next time the user edits a variable in the UI, which violates "do not silently replace user assumptions". |
| **M-2 · UI_INTEGRATION_GAP (P0)** | No correlation editor exists; the text at line 660 tells users to use API / MCP. |
| Outputs | Mean, P50, SD, P5 / P10 / P25 / P75 / P90 / P95, invalid count, histogram and warnings are shown and labelled as a valuation distribution, not VaR. NO_CHANGE. Optional P2: a standard error for the mean and a binomial interval for "P(value > price)". |
| Historical correlation estimation | Not offered. No synchronised driver history exists for valuation assumptions, so per spec §6.3 it is **not** proposed. |

**Portfolio Monte Carlo: NOT_IMPLEMENTED.** This is reported as a gap only and will not be built (spec §6.6).

## 4. Portfolio optimization

**Status: EXISTS_AND_WORKS.**

| Item | Location | Finding |
|---|---|---|
| E[R_p] = wᵀμ, σ_p = √(wᵀΣw) | `mpt.ts:48` | Verified by hand. NO_CHANGE. |
| Inputs | `mpt.ts:20`, optimizer universe | Returns on common actual dates (`return-series.ts` `commonDates`, no forward-fill), μ = mean × N, Σ = sample × N. NO_CHANGE. |
| Ledoit–Wolf | `mpt.ts:197` | Matches numpy to 1e-12. Its S uses 1/T while the sample matrix uses 1/(T−1), so at δ → 0 the two differ by a factor of T/(T−1) (0.2% at T = 500). METHODOLOGICAL_LIMITATION, to document, no change. |
| PSD / conditioning | `mpt.ts:173` | Clipping with a warning; condition-number warning. NO_CHANGE. |
| Expected return sources | historical, CAPM, blend, Black–Litterman (`black-litterman.ts:65`), bond yield horizon (PR4) | NO_CHANGE. A per-asset user-defined μ is available through BL views, not as direct input. Noted. |
| Constraints | long-only, min / max, groups, issuer, sector, currency, maturity buckets, short policy (`short-policy.ts:44`, enforced inside the QP, with a defence-in-depth check) | NO_CHANGE. An infeasible problem raises `INFEASIBLE_CONSTRAINTS`. There is no duration constraint (not required). |
| Frontier, GMV, tangency | `optimizer.ts:694` | Exact active-set QP; returns null when no portfolio beats Rf. NO_CHANGE. |
| Robustness | `robust.ts:43` | Bootstrap and μ-shock diagnostics, explicitly described as "not a formal robust optimization". NO_CHANGE. |
| `/analytics` MPT panel | `services/portfolio.ts:120–175` | Uses **price** returns (close prices, dividends excluded), whereas the optimizer page can use total return. METHODOLOGICAL_LIMITATION (P2): label the panel "price return", or reuse the optimizer universe. |

## 5. Performance ratios

**Status: EXISTS_AND_WORKS.**
- **Sharpe** (`metrics.ts:270`) = mean(r − rfₜ)/sd(r − rfₜ)·√N, with per-period Rf compounded from the annual rate. Verified.
- **Sortino** (`metrics.ts:162, 271`) uses MAR = per-period Rf and downside deviation over all observations. Verified. The spec asks for a selectable MAR rather than an implicit Rf: UI_INTEGRATION_GAP (P2). Add an optional `sortinoMar` setting (default Rf, so outputs are unchanged) and label the MAR used.
- **Calmar** (`metrics.ts:272`) = CAGR / MDD, only for periods ≥ 1 year; null when MDD = 0; negative when CAGR < 0. Verified. NO_CHANGE.

## 6. CAPM, β and Rf

**Status: EXISTS_AND_WORKS.**
- **Ke:** `valuation.ts:11` Ke = Rf + β·ERP + premium. Verified.
- **β:**
  - `risk.ts:35` and `return-series.ts` `alignWithBenchmark` compute it on common actual dates, with no forward-fill. Look-ahead is not possible because history only.
  - The performance page uses an OLS of excess returns with a standard error (`metrics.ts:91`).
  - NO_CHANGE.
- **Rf:**
  - Settings holds the rate, source and as-of date; the curve has currency and kind (PR1 / PR2).
  - The resolver (`risk-free.ts`) handles tenor and fallback, and never uses an owned bond's YTM.
  - NO_CHANGE.

## 7. WACC and DCF

**Status: EXISTS_AND_WORKS.**

| Item | Location | Finding |
|---|---|---|
| WACC | `valuation.ts:16, 309` | Target D/(D+E), or market E = price × shares with book debt (labelled). Verified. NO_CHANGE. |
| FCFF / FCFE, staged, terminal methods | `valuation.ts:322 validateDcf`, `:467 dcf` | r ≤ g is rejected with an error (not silent). Verified with a hand FCFF case. Golden tests exist. NO_CHANGE. |
| Bridge | `valuation.ts:438` | FCFF: EV − debt + cash − otherClaims. FCFE: PV + cash. |
| FCFE minorities | `valuation.ts:438` | **UNVERIFIED_CONCERN.** The FCFE bridge does not deduct `otherClaims` (minority interest). That is correct when forecast net income is already attributable to the parent; it double counts when the forecast uses consolidated net income. The model cannot tell which. Proposal (P2): an explicit `netIncomeBasis: "attributable" \| "consolidated"` on FCFE (default `attributable`, so values are unchanged), with a warning when `otherClaims > 0` and the basis is consolidated. |

## 8. SOTP

**Status: EXISTS_AND_WORKS** (`sotp.ts:124`).
- **Checks present:**
  - duplicate entities;
  - debt counted twice or omitted;
  - minority missing or double counted;
  - cash double count;
  - FX and ownership.
- **Reconciliation:** checked to 1e-6.
- **Scenarios:** run through the full bridge (PR11).
- NO_CHANGE.

## 9. Bank valuation

**Status: EXISTS_AND_WORKS.**
- **Single-stage RIM** (`:788`) = B₀ + (ROE−Ke)B₀/(Ke−g). **Justified P/BV** (`:909`) = (ROE−g)/(Ke−g), equal to RIM/B₀ (verified).
- **Justified P/E** (`:904`) = payout·(1+g)/(Ke−g), i.e. the trailing form.
- **Multi-stage RIM:** clean surplus, three terminal methods, horizon tests (Phase 5).
- **Two-stage DDM:** verified by hand. **H-model:** H = years/2 (Fuller–Hsia).
- **METHODOLOGICAL_LIMITATION (P2), spec §13.3:** single-stage RIM and justified P/E take a user `terminalGrowth` that may differ from sustainable g = ROE·(1 − payout).
  - Proposal: a warning when |g − ROE·(1 − payout)| > 1 pp. No value change.

## 10. Bonds

**Status: EXISTS_AND_WORKS** (`bonds.ts`, `BondCalculator.tsx`).

| Item | Finding |
|---|---|
| Price, accrued, YTM, Macaulay / modified duration, convexity, DV01 | Verified against an independent closed form (table above). NO_CHANGE. |
| Approximation vs full repricing | Already shown side by side (`BondCalculator.tsx:275`). NO_CHANGE. |
| Ex-coupon handling in horizon return | Consistent (verified). NO_CHANGE. |
| Horizon return breakdown | `bonds.ts:438` returns `couponsAndReinvestment` as one number. **UI_INTEGRATION_GAP (P1), spec §14.5:** split into coupon income, reinvestment income and price return (sale − initial dirty), and label YTM as "hold to maturity with reinvestment at YTM", not as a realized return. This adds additive fields; the existing ones are unchanged. |
| **B-1 · UI_INTEGRATION_GAP (P1)** | Named multi-scenario analysis (Bear / Base / Bull / custom, probabilities, scenario exit yield and reinvestment, weighted clean price) exists in the scenario engine for `method: "bond"` (REST / MCP), but `BondCalculator` only has a single shock and a single horizon. Proposal: a scenario table in the calculator that **reuses `runScenarios`** (paths `yieldShiftBp`, `horizon.exitYield`, `horizon.reinvestRate`). No new pricing code. Persistence: there is no saved-bond-valuation record, so scenarios are kept in local state only. Saving to the existing valuations table would need `method = bond` in the editor; this is deferred and needs a decision. |

## 11. Data quality

- **Present:** price coverage (`price-coverage.ts`), stale flags (`MAX_STALE_DAYS`, `portfolio.ts:390`), FX staleness, inferred flows, the data-quality page, and timestamp policies.
- **Additions:** D-1 above, plus the "carried price" count in the performance data quality.
- Nothing is fabricated: there is no default yield curve, β falls back to 1 only in a *new* editor form and is labelled, and no rating is invented.

## 12. API / MCP

All engines are reachable through REST and MCP (PR15 parity check, 20/20). The fixes proposed here change only:
- additive optional fields (`linearReturn`, multi-horizon VaR rows, horizon breakdown);
- UI state.

No route, tool name or required field changes.

---

## Implementation plan (for review — not started)

| Phase | Item | Class | Change | Tests |
|---|---|---|---|---|
| 1 (P0) | **S-1** stress loss > 100% | CONFIRMED_BUG | `stress.ts`: `linearReturn` plus a floored long-only return with a per-position warning; totals use the floored value | hand case β 1.8 × −60% → −100% plus warning; unchanged when within range |
| 1 (P0) | **H-1** multi-horizon historical VaR / ES | NOT_IMPLEMENTED | `var-backtesting.ts`: `horizonVarTable(rs, horizons)` with compounded R_H, overlapping and non-overlapping, minimum samples. `metrics.ts`: additive `varHorizons`. Analytics UI: horizon selector and THB amounts | hand sample; R_H ≥ −100% on long-only data; insufficient-data path; √h shown only as a labelled comparison |
| 1 (P1) | **D-1** synchronised-date risk statistics | DATA_QUALITY_ISSUE | `metrics.ts`: optional `syncDates` → vol / VaR / Sharpe on the wealth index at synchronised dates; carried-price count in `dataQuality` | two-calendar synthetic case: TWR identical, the zero-return days removed from the risk sample |
| 2 (P0) | **M-1 / M-2** correlation editor | CONFIRMED_BUG (UI) + gap | `ScenarioWorkbench`: Independent / Manual modes; n×n editor with symmetric mirroring, locked diagonal at 1, range check; PSD check through `prepareCorrelation`; "repair" requires explicit confirmation; editing distribution parameters keeps the matrix; add / remove a variable resizes it, preserving existing pairs | engine tests for ±ρ (existing) plus pure helpers for resize / mirror / validate; UI ↔ REST ↔ MCP parity for a correlated config |
| 3 (P1) | **B-1** bond scenarios in BondCalculator | UI_INTEGRATION_GAP | scenario table (presets plus custom; yield shift, exit yield, reinvestment, probability) via `runScenarios`; weighted clean price; comparison table | weighted price = Σp·price, with each scenario price checked against `analyticsFromYield` at the shifted yield |
| 3 (P1) | horizon return breakdown | UI_INTEGRATION_GAP | `horizonReturn`: additive `couponIncome`, `reinvestmentIncome`, `priceReturn`; calculator labels | coupon + reinvestment + price = future value − initial (hand) |
| 4 (P2) | FCFE `netIncomeBasis`, RIM g-consistency warning | UNVERIFIED / LIMITATION | warnings and an opt-in field; default values unchanged | golden tests unchanged; warning cases |
| 5 (P2) | Sortino MAR option, VaR period label, MPT panel return label | UI gaps | settings field (default Rf), labels | default output identical |
| 6 | Regression | — | vitest, tsc, lint, build, check scripts, optimizer baseline comparison, e2e smoke | — |

## Explicitly not changed

- Return / TWR / XIRR, the CAPM / β / Rf resolver, optimizer maths, Ledoit–Wolf, Black–Litterman, the robust diagnostics, DCF / SOTP / RIM / DDM formulas, bond pricing, and the Monte Carlo engine. All are verified above.
- Portfolio Monte Carlo is a gap and is not built.
- No Decision Tree valuation.
