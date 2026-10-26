# Financial Model Remediation — Summary (PR 1–5)

| PR | Scope | New regression tests (fail before / total) | Commit |
|---|---|---|---|
| 1 | Ledger integrity, cash policy, price/FX status, performance conventions (TWR timing, annualization, periodic Sharpe, XIRR roots, benchmark alignment, OLS alpha/beta, VaR sample) | ledger 13/16, performance 18/19 | `f087e37` |
| 2 | DCF validation, stable-ROIC terminal, mid-year TV timing, FCFE debt schedule, sensitivity N/A, scenarios, reverse-DCF status, input provenance | 16/18 | `66b872b` |
| 3 | Optimizer: no silent bound relaxation, exact active-set QP, target return/risk, max Sharpe, CAL objectives, covariance diagnostics, common calendar | 17/17 | `d28b74f` |
| 4 | Bonds: EOM, stubs, day counts, ex-coupon, amortization, YTC from actual schedule, YTW, horizon return, effective risk, curve/Z-spread/KRD | 16/19 | `4be5d91` |
| 5 | Governance: Rf/ERP provenance, model version, % guard, import/export, data-quality report, bond conventions on assets, model documentation, end-to-end test | 10/10 (+7 e2e) | see PR 5 |

Final state: `npm test` 169 passed, lint clean, `tsc` clean, `npm run build` succeeds. Database migrations 0004 and 0005 only add columns; no user data was rewritten.

Per-PR details: `PR1_REPORT.md` … `PR5_REPORT.md`. Formulas and conventions: `../MODEL_DOCUMENTATION.md`.
