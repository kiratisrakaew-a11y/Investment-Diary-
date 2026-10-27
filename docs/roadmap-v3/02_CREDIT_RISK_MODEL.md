# Phase 2 — Bond credit risk and credit-spread scenarios

Module: `src/lib/finance/credit-risk.ts` (pure). It reuses `bonds.ts` `schedule`, `priceFromCurve` and `zSpread`; the cash-flow, YTM, duration and convexity code is unchanged.

## Inputs (user-provided; nothing inferred)
- `assets.credit` (jsonb, `creditProfileSchema`):
  - rating + agency + date (missing → `unrated`), seniority
  - PD `{ type: hypothetical | historical | market_implied, source, asOf, annual | cumulative[{years, pd}] }`
  - LGD `{ value, source, asOf }`
  - Validated: 0 ≤ PD < 1, 0 ≤ LGD ≤ 1, cumulative PD non-decreasing (survival non-increasing), annual and cumulative not both.
- `assets.issuer` (economic issuer).
- `settings.yield_curve` `{ points[{years, rate}], source, asOf }`: government zero rates, annual compounding.
- Migration `0010_v3_risk_metadata.sql` is additive (nullable columns).
- PD is never derived from a credit spread.

## Calculations (per 100 face)
- Survival S(t): constant annual hazard, or log-linear survival between cumulative points with the last hazard extrapolated (flagged `PD_EXTRAPOLATED`).
- Simplified 1-year EL = PD₁ × LGD × EAD, with EAD = outstanding principal + coupons due within 1 year. This is labelled **not** TFRS 9 / IFRS 9 ECL.
- Term: per remaining payment period k (default at the period end before payment, recovery at the same time):
  - marginal_k = S(t_{k−1}) − S(t_k)
  - EAD_k = principal outstanding before t_k + coupon due at t_k
  - PV(EL) = Σ marginal_k · LGD · EAD_k · DF(t_k)
- Credit-adjusted expected value = Σ S·CF·DF + Σ marginal·(1 − LGD)·EAD·DF. It is shown next to the contractual PV and is not compared with YTM.
- DF comes from the supplied curve; otherwise a flat Rf from settings, labelled.
- Spread: Z-spread over the supplied curve; spread DV01 = (P(z − 1bp) − P(z + 1bp))/2 on the dirty price per 100; spread duration = DV01/(P·1bp); option-free, parallel. Without a curve → `unavailable` with the required input.

## Stress (`stress.ts`, `stress_test_portfolio`; backward-compatible)
- New fields: `creditSpreadShockBp`, `creditSpreadShockBpBySymbol`, `spreadDurationOverride`. Presets `credit_widening` and `rates_and_credit` are added.
- Bonds: −SD·Δs + ½C[(Δy + Δs)² − Δy²], repriced once on the combined change. The rate line = f(Δy); the credit line carries the cross term, so lines sum to the total.
- SD comes from Z-spread repricing when a curve is set, else modified duration (labelled proxy); funds need an override (otherwise a warning).
- Equities are unaffected.
- Outputs `byFactor.credit` and `exposure.byIssuer` / `byRating` (unrated is kept as unrated).
- Rating transitions and defaults are not simulated (no data).

## Surfaces
- Bonds page: a "ความเสี่ยงเครดิต" panel per bond with an editor (`CreditProfileForm`).
- Settings: a yield-curve form.
- REST: `POST /api/v1/assets/profile`, `PUT/GET /api/v1/settings/yield-curve`.
- MCP / advisor: **new** `update_asset_profile` (no existing tool can edit asset metadata; `add_asset` only creates). `get_bond_holdings` / `GET /api/v1/bonds` gain `credit`; `stress_test_portfolio` gains the credit fields.

## Tests
- `credit-risk.test.ts` (8):
  - S(t), conditional/marginal sums, log-linear cumulative interpolation, non-monotone PD rejected
  - EL validation
  - 2-year 5% bond hand-calculated PV(EL), contractual PV and credit-adjusted value
  - zero PD, 100% LGD, maturity EAD
  - missing data → unavailable (rating `unrated`)
  - ±1bp symmetric repricing, 100bp repricing, sparse curve
- `stress-credit.test.ts` (6): 100bp alone; rate + spread repriced once (sum = f(Δy + Δs)); curve SD and per-symbol shock; equity unaffected and fund warning; attribution sums; legacy payload unchanged.
- The existing stress tests pass unchanged.

## Local verification (test values, then removed)
- LB29DA with a hypothetical PD (cumulative 0.05% at 1 year, 0.2% at 3 years) and LGD 45% (test scenario), and a test curve:
  - PV(EL) 0.092 per 100; credit-adjusted value 101.68 vs contractual 101.77
  - spread duration 2.95 vs modified duration 2.99
  - stress (+100bp rates, +50bp spread): rate −1,477 + credit −710 = −2,188 THB
- Before any input: `unavailable` with the required list.
- A sector without source/date is rejected.
- The profile, curve and sector were cleared afterwards.
