# PR 2 — Equity Valuation Reliability (Phase C, P1)

Spec: `INVESTMENT_DIARY_FINANCIAL_MODEL_REMEDIATION.md` §4 and §9 (PR 2) · Branch: `claude/vigilant-fermi-tf3wq7` · Baseline: PR 1 (`17236ab`)

## 1. Summary

| Area | Before | After |
|---|---|---|
| Invalid inputs | r ≤ g produced `NaN` (shown as "–") plus a warning; shares = 0 divided by zero; any tax rate accepted | Structured `errors[]` (`RATE_NOT_ABOVE_GROWTH`, `INVALID_SHARES`, `INVALID_TAX`, `NEGATIVE_REVENUE`, `INVALID_YEARS`, `INVALID_TERMINAL_RETURN`, …). Value, equity value, EV and upside are `null`. Saving such a valuation is rejected (REST 400 / MCP `isError`) |
| Terminal value | Only `last CF × (1+g)` (kept the last year's reinvestment, whatever it was) or an exit multiple | New **stable ROIC / ROE** method: reinvestment = g ÷ ROIC (FCFF) or g ÷ ROE (FCFE). Every perpetuity method reports the year n+1 reconciliation: earnings(n+1), CF(n+1), reinvestment rate, implied ROIC/ROE, implied EV/EBITDA or P/E |
| Gordon sanity | none | Warns on growth without reinvestment (an implicit infinite ROIC), implied ROIC > 40%, and FCFE terminal flows that include net borrowing |
| TV dominance | warning only above 80% | Warnings above 70% and above 80% |
| Mid-year | Explicit flows at t − 0.5, but perpetuity TV discounted at n (inconsistent) | Perpetuity TV discounted at n − 0.5 (its flows are mid-year too). Exit-multiple TV stays at n (a point-in-time price) |
| FCFE debt | Only δ × net reinvestment; no debt schedule shown | Borrowing policy: fixed ratio δ, or an explicit net-borrowing schedule per year. Schedule shown: opening debt → interest on opening debt → net borrowing → closing debt. A short schedule is flagged |
| FCFF/FCFE reconciliation | unlevered case only | Also a test with leverage: constant perpetual debt (Modigliani–Miller with taxes), where both methods give equity = 1,200 |
| Sensitivity | WACC × g only; invalid cells were `NaN` | Rows are WACC or Ke. Columns can be g, terminal ROIC/ROE, EBIT margin, capex or δ. Invalid cells are `null` and shown as "N/A" |
| Scenarios | none | Bear/Base/Bull with probabilities (must total 100%). Shows each value, expected value, range and σ. Saved with the assumptions |
| Reverse DCF | single bisection over [−50%, 100%]; returned a number or null | Grid scan plus bisection per bracket. Status `ok` / `no_root` / `multiple_roots` with candidates |
| Input provenance | none | Optional `inputMeta` (as-of date, Rf / ERP / beta source) on DCF, DDM and RI. Unsourced inputs are labelled "default is illustrative" in the calculation detail |
| Multiples | trailing vs forward not stated | `earningsBasis` (trailing by default / forward) is shown in the calculation detail |
| Banks | — | The UI notes that FCFF is unsuitable for financials and suggests DDM / RI |

## 2. Formulas

- Stable ROIC (FCFF): `NOPATₙ₊₁ = NOPATₙ(1+g)`, `RR = g/ROIC`, `FCFFₙ₊₁ = NOPATₙ₊₁(1 − RR)`, `TVₙ = FCFFₙ₊₁/(WACC − g)`.
- Stable ROE (FCFE): `NIₙ₊₁ = NIₙ(1+g)`, `RR = g/ROE`, `FCFEₙ₊₁ = NIₙ₊₁(1 − RR)`, `TVₙ = FCFEₙ₊₁/(Ke − g)`.
- Gordon (unchanged formula, now with disclosure): `CFₙ₊₁ = CFₙ(1+g)`; implied `RR = 1 − CFₙ₊₁/earningsₙ₊₁`, implied `ROIC = g/RR`.
- Mid-year: `PV(TV) = TV/(1+r)^(n−0.5)` for perpetuities, `TV/(1+r)^n` for exit multiples.
- FCFE debt: `interestₜ = openingDebtₜ × Kd`, `NIₜ = (EBITₜ − interestₜ)(1 − t)`, `FCFEₜ = NIₜ − (capex − D&A) − ΔNWC + netBorrowingₜ`, `closingDebtₜ = openingDebtₜ + netBorrowingₜ`.
- Scenarios: `E[V] = Σ pᵢVᵢ`, `σ = √Σ pᵢ(Vᵢ − E[V])²`; no expected value unless `Σp = 1`.

## 3. Before / after examples

| Case | Before | After |
|---|---|---|
| Flat perpetuity FCFF 150, WACC 10%, mid-year | EV 1,527.75 (explicit flows at t − 0.5, TV at n) | EV 1,573.21 = 1,500 × 1.1^0.5 (analytic) |
| WACC 6.52% with g = 20% (local PTT example) | value "–", save stored a null fair value | `RATE_NOT_ABOVE_GROWTH`; save → 400 "บันทึกไม่ได้ …" |
| PTT example, Gordon (saved) vs stable ROIC 12% | 33.88 | Gordon 33.88 (unchanged), stable ROIC 43.69 (RR 12.5%, implied EV/EBITDA 7.9x) |
| Sensitivity cell with r < g | `NaN` | `null` → "N/A" |

## 4. Changed files

- `src/lib/finance/valuation.ts` — validation, terminal methods and reconciliation, mid-year TV timing, debt schedule, sensitivity axes, reverse-DCF status, scenarios.
- `src/lib/valuation-schemas.ts` — new fields (`terminalMethod: stable_roic`, `terminalRoic`, `terminalRoe`, `debtPolicy`, `netBorrowingSchedule`, `scenarios`, `inputMeta`, `earningsBasis`); `evaluate` returns `errors`, `terminal`, `reverseDcf`, `scenarios`.
- `src/lib/valuation-explain.ts` — steps for the year n+1 reconciliation, reinvestment, implied multiple, TV timing, scenarios, sources; debt rows in the FCFE table.
- `src/components/ValuationEditor.tsx` — terminal method / ROIC, FCFE borrowing policy and schedule, sources, error messages, terminal panel, sensitivity axis selector, scenario panel, earnings basis.
- `src/components/SavedValuationList.tsx` — parses saved assumptions (defaults for new fields) and flags when the current formulas give a different value than the stored one.
- `src/server/services/valuations.ts` — refuses to save a valuation without a valid value.
- Tests: new `src/lib/finance/valuation-pr2.test.ts` (21); `valuation.test.ts` r ≤ g test updated to check the error.

## 5. Migration impact

No database migration. The new assumption fields are optional with defaults. Saved valuations are not rewritten; their stored fair value stays as saved.
Only saved DCFs that use **mid-year** with a perpetuity terminal value recompute differently. The stock page then shows a note with both numbers ("ค่าที่บันทึกไว้ … สูตรปัจจุบันได้ …"); re-saving updates the stored value. Saved DCFs without mid-year recompute identically (verified locally: 33.884171… before and after).

## 6. Verification (actual results)

| Command | Result |
|---|---|
| `npx vitest run src/lib/finance/valuation-pr2.test.ts` on the PR 1 code | 16 failed / 2 passed (18). The 2 passing are consistency checks the old code already met (exit-multiple timing, MM reconciliation) |
| `npm test` | 8 files, **116 passed** |
| `npm run lint` | No ESLint warnings or errors |
| `npx tsc --noEmit` | 0 errors |
| `npm run build` | success |
| REST `POST /api/v1/valuations` with g > WACC | 400 with the reason |
| REST `POST /api/v1/valuation/evaluate` stable ROIC | value 43.69, terminal detail and reverse-DCF status returned |
| Browser: editor (stable ROIC, scenarios on) and stock page | rendered, no console errors |

## 7. Open issues

- Target debt-to-capital policy with year-varying leverage (needs time-varying Ke or APV) is not implemented; the explicit schedule covers user-specified debt paths.
- Reverse DCF solves for revenue growth only; implied margin is not implemented yet.
- Beta tools (Hamada un/relever exist in code) are not exposed in the editor; peer-set beta and the beta window are free text via `inputMeta.betaSource`.
- Full assumption governance (versioned audit trail, source registry) is PR 5.
- Next: PR 3 optimizer (`projectBoxSimplex` silently relaxing infeasible bounds), PR 4 bond conventions.
