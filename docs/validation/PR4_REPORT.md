# PR 4 — Fixed Income Conventions (Phase D, P1/P2)

Spec: `INVESTMENT_DIARY_FINANCIAL_MODEL_REMEDIATION.md` §5 and §9 (PR 4) · Branch: `claude/vigilant-fermi-tf3wq7` · Baseline: PR 3 (`d28b74f`)

## 1. Summary

| Area | Before | After |
|---|---|---|
| Coupon schedule | Always regular, built backwards from maturity. Day clamped at month end, but no EOM rule: a 30 Apr maturity gave 30 Oct coupons | End-of-month rule (automatic when maturity is a month end, can be overridden). `issueDate` + `firstCouponDate` give a short or long first coupon; `penultimateCouponDate` gives an irregular last period. A first coupon that is off the cycle is rejected (`MALFORMED_SCHEDULE`) instead of being assumed |
| Day count | ACT/ACT (ICMA) only | ACT/ACT-ICMA (default), ACT/365F, ACT/360, 30/360 (bond basis) for accrued interest and irregular coupons. Discounting uses ICMA quasi-coupon periods |
| Payment dates | — | Weekend roll for payments (following / modified following); accrual keeps unadjusted dates. No holiday calendar (disclosed) |
| Ex-coupon | — | `exCouponDays`: inside the window the next coupon goes to the seller and accrued interest is negative |
| Amortizing / zero coupon | zero coupon worked; no amortization | Principal repayments on coupon dates. Coupons are on the outstanding amount; schedules that repay ≥ 100 are rejected |
| Yield to call | Treated the call date as a new maturity and rebuilt the coupon dates backwards from it (wrong coupon dates when the call is off-cycle) | The bond's own coupons up to the call date, then call price + accrued coupon at the call date |
| Yield to worst | — | Minimum of YTM and the yield to every call in `callSchedule`, reporting which date is worst |
| Horizon / realized return | — | Buy now, reinvest coupons at a chosen rate, sell at an exit yield. Gives total return and a bond-equivalent annual rate comparable with YTM |
| Risk | Analytic Macaulay / modified duration, convexity, DV01 | Plus bump-and-reprice effective duration and convexity (reconciled to analytic in tests), and an exact reprice table at ±25/50/100bp next to the duration+convexity approximation |
| Spot curve | — | Price from a zero curve (annual compounding, linear interpolation, flat extrapolation), Z-spread, and key-rate durations by node bumps (they sum to the curve duration). Clearly separated from YTM pricing |
| Validation | `Error` text only; price ≤ 0 failed inside the solver; yields floored at 0.01% in the price–yield chart | Typed `BondError` (`INVALID_DATES`, `MALFORMED_SCHEDULE`, `INVALID_PRICE`, `INVALID_INPUT`, `NO_YIELD`) → REST 400 with `code`. Negative yields allowed while 1 + y/f > 0 |
| Labels / credit | — | Current yield labelled "coupon ÷ price — not YTM". Optional issuer and rating (agency, date), with a caveat that yield includes credit and liquidity compensation. Portfolio bonds show their assumed conventions (semi-annual, regular, ACT/ACT-ICMA) |
| Floating-rate notes | — | Not supported. Negative coupon is rejected with a message (a fixed-coupon formula is not applied to FRNs) |

## 2. Formulas

- Quasi-period time: `t(settle, d) = Σ overlap(quasi period) / length(quasi period)`. Dirty price `= Σ CF/(1 + y/f)^t`; clean `= dirty − accrued`.
- Irregular coupon (ICMA): `(c·100/f) × Σ quasi fractions`. Other day counts: `c·100 × DCF(start, end)`.
- Accrued: ICMA `(c·100/f)·t(start, settle)`; others `c·100·DCF(start, settle)`. Ex-coupon: accrued − period coupon.
- 30/360: `D1 = min(D1, 30)`; if D2 = 31 and D1 = 30 then D2 = 30; days = 360ΔY + 30ΔM + ΔD.
- Horizon: `FV = Σ CFᵢ(1 + r/f)^(t_H − tᵢ) + P_dirty(H, y_exit)`; annual = `f[(FV/P₀)^(1/t_H) − 1]`.
- Curve: `P = Σ CF/(1 + z(t) + s)^t`; Z-spread solves `P(s) = market`; KRDₖ = `[P(zₖ − 1bp) − P(zₖ + 1bp)]/(2P·1bp)`.

## 3. Before / after

| Case | Before | After |
|---|---|---|
| Maturity 30 Apr 2030, previous coupon | 2029-10-30 | 2029-10-31 |
| Off-cycle call 2027-09-01 on a 15 Jun/15 Dec bond | coupons rebuilt as 1 Mar/1 Sep | actual Jun/Dec coupons plus accrued at call; matches an independent solve to 1e-8 |
| First coupon 2026-03-01 on a Jun/Dec cycle | silently ignored | 400 `MALFORMED_SCHEDULE` |
| Accrued, ACT/365F vs ICMA | always ICMA | per the chosen convention (tested to 1e-10) |
| Local example: 4.5% 2035, price 101.5, calls 2029@101 / 2031@100 | YTM only | YTM 4.290%, YTW 4.140% (call 2031), effective duration 6.999 = modified 6.999, Z-spread 169 bp vs example curve, 2-year horizon 4.206% |

## 4. Changed files

- `src/lib/finance/bonds.ts` — schedule builder (EOM, stubs, day counts, business-day roll, ex-coupon, amortization), typed errors, YTC from the actual schedule, YTW, horizon return, effective risk measures, scenarios, curve pricing, Z-spread, KRD.
- `src/lib/valuation-schemas.ts` — `bondSchema` (conventions, `callSchedule`, `amortization`, `zeroCurve`, `horizon`, issuer/rating); bond `evaluate` returns YTW, curve, horizon and a credit note (REST, MCP `analyze_bond`, advisor).
- `src/server/api.ts` — `BondError` → 400 with `code`.
- UI: `src/components/BondCalculator.tsx` (conventions, calls/YTW, scenarios, horizon, curve/Z-spread/KRD, credit), `src/app/(app)/bonds/page.tsx` (assumed conventions for holdings, subtitle).
- Tests: new `src/lib/finance/bonds-pr4.test.ts` (19). Existing bond tests (par, 92.5613, duration, round trip, T-bill) unchanged and passing.

## 5. Migration impact

No database change. Regular bonds give the same results as before (the existing 92.5613 and round-trip tests are unchanged). Results change only for month-end maturities (EOM rule) and for yield to call when the call date is off the coupon cycle. Bond assets in the portfolio have no stored frequency or day count, so holdings analytics still assume semi-annual ACT/ACT-ICMA; this is now disclosed on the page.

## 6. Verification (actual results)

| Command | Result |
|---|---|
| `npx vitest run src/lib/finance/bonds-pr4.test.ts` on the PR 3 code | 16 failed / 3 passed (19). The 3 passing are zero coupon, negative yield and an ACT/365F round trip, which the old code already satisfied because it ignored the day count |
| `npm test` | 10 files, **152 passed** |
| `npm run lint` | No ESLint warnings or errors |
| `npx tsc --noEmit` | 0 errors |
| `npm run build` | success |
| REST `POST /api/v1/bonds/analyze` with calls, curve and horizon | YTM, YTW, curve price, Z-spread, KRD, horizon return and credit note returned |
| REST with an off-cycle first coupon | 400 `MALFORMED_SCHEDULE` |
| Browser: bonds page with conventions, call, horizon and curve | rendered, no console errors |

## 7. Open issues

- Not validated against a published ThaiBMA price/yield for a specific security and settlement date (needs a reference quote; the convention options are in place).
- Holiday calendars (Thai / US) are not included; only weekends are rolled.
- Floating-rate notes, inflation-linked bonds, sinking-fund calls and option-adjusted spread are not implemented.
- Bond assets do not store frequency, day count or call schedule; adding them needs a migration (could go with PR 5).
- Next: PR 5 (assumption governance and provenance, data-quality panel, end-to-end report).
