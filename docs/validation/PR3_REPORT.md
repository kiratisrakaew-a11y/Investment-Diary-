# PR 3 — Portfolio Optimizer Correctness (Phase E, P0/P1)

Spec: `INVESTMENT_DIARY_FINANCIAL_MODEL_REMEDIATION.md` §6 and §9 (PR 3) · Branch: `claude/vigilant-fermi-tf3wq7` · Baseline: PR 2 (`66b872b`)

## 1. Summary

| Area | Before | After |
|---|---|---|
| Weight bounds | `projectBoxSimplex` and `feasibleReturnRange` silently raised `max` to 1/n. Example: 3 assets with max 20% → about 33.3% each | `validateBounds` requires `n·min ≤ 1 ≤ n·max` and `min ≤ max`. Infeasible bounds give a typed `INFEASIBLE_BOUNDS` with a suggestion. No weights are returned. REST answers 400 with `code`; MCP answers `isError` with the code and suggestion; the advisor gets `{ ok: false, issue }` |
| Solver | Projected gradient with a fixed iteration count; no convergence report | Exact primal active-set QP for `min ½wᵀQw + cᵀw` with Σw = 1 and lo ≤ w ≤ hi. Reports status, iterations, KKT residual, \|Σw − 1\|, largest bound violation, and whether a ridge was added. Every result is checked against the bounds (tolerance 1e-8) before it is returned |
| Target return | Penalty method; a target out of range fell back to "the nearest value" | Bisection on λ, accurate to below 1e-9, on both arms of the bullet. A target outside the exact feasible range gives `INFEASIBLE_TARGET_RETURN` with the range |
| Target risk | Picked one of 40 sampled frontier points; a target below the GMV silently returned the GMV | Exact max E[R] subject to σ ≤ target; the constraint binds, verified against a brute-force grid. A target below σ_GMV gives `INFEASIBLE_TARGET_RISK`. A non-binding target is reported |
| Max Sharpe | Golden-section over λ with the approximate solver | Golden-section over λ with the exact QP (Sharpe is quasi-concave along the efficient arm). Verified against a grid and the analytic tangency. If no portfolio beats Rf: `NO_EXCESS_RETURN` (no tangency, no CML) |
| Risk-free asset | Any objective was silently replaced by max Sharpe | Objectives are solved on the CAL: target return → y = (t − Rf)/(E_T − Rf); target risk → y = σ*/σ_T; utility/max Sharpe → y*; min variance → 100% Rf. Borrowing (y > 1) or y < 0 is clamped with a disclosed warning |
| Covariance | Always a 1e-8 ridge, even in the closed-form frontier | Jacobi eigen-check: a non-PSD matrix is repaired by eigenvalue clipping (with a warning); condition number > 1e8 gives a warning. The ridge is used only when the matrix is singular. Ledoit–Wolf (2004) shrinkage is selectable and its δ is shown |
| Calendar / annualization | Union calendar with forward-filled prices (zero returns on holidays); fixed 252 | Only dates on which every asset has an actual price. N = observations per year from the data (≈ 260.6 on the local data). Historical E[R] = arithmetic mean × N, which is consistent with the annualized covariance |
| UI disclosure | "ผสม 50/50 (ลด estimation error)" | "ผสม 50/50 (heuristic)". The legend separates the investable constrained frontier from the closed-form short-sales curve (not investable). Rf point and CML are shown only when a tangency exists. Solver panel and constraint summary added. "ใช้เป็นเป้าหมาย" is only enabled for a valid result |

## 2. Formulas

- Frontier parameter: `min wᵀΣw − λ μᵀw` subject to Σw = 1 and lo ≤ w ≤ hi. λ = 0 is the GMV; λ > 0 the efficient arm; λ < 0 the inefficient arm. Utility uses λ = 2/A.
- Feasible return range (LP): fill the minimum weight everywhere, then top up the highest (or lowest) μ assets to the maximum.
- Active set: KKT on the free set `[Q_FF 1; 1ᵀ 0][p; ν] = [−g_F; 0]`. Release a bound when `g_i − ν < 0` at the lower bound or `> 0` at the upper bound.
- CAL: `E = Rf + y(E_T − Rf)`, `σ = y·σ_T`.
- Ledoit–Wolf: `Σ* = δ·m·I + (1 − δ)·S`, with `δ = min(b̄², d²)/d²`.

## 3. Before / after

| Case | Before | After |
|---|---|---|
| 3 assets, max 20% | about 33.3% each (cap violated) | `INFEASIBLE_BOUNDS`: "เพิ่มน้ำหนักสูงสุดเป็นอย่างน้อย 33.4% หรือเลือกสินทรัพย์อย่างน้อย 5 ตัว" |
| Closed-form GMV vs QP with loose bounds | differed by 1.4e-7 (hidden ridge) | equal to 1e-8 |
| Target return 12% when the max feasible is 10% | silently returned the 10% portfolio plus a note | `INFEASIBLE_TARGET_RETURN` with the range 6.0%–10.0% |
| Rf + target return 6% | switched to tangency, giving a different return | E[R] = 6.000000% on the CAL |
| Local data, max Sharpe, max 40% | — | optimal in 9 iterations, KKT 2e-18, \|Σw − 1\| 1e-16, cond(Σ) 230 |

## 4. Changed files

- `src/lib/finance/optimizer.ts` — feasibility, `OptimizerError`, active-set QP, GMV / target return / target risk / tangency / utility, λ-traced bullet; ridge only when singular.
- `src/lib/finance/mpt.ts` — `symmetricEigen`, `covarianceDiagnostics`, `ledoitWolf`.
- `src/lib/finance/recommend.ts` — `RecommendOutcome` (ok / typed issue), CAL handling, final constraint check, diagnostics.
- `src/server/services/optimizer.ts` — common calendar, N from data, shrinkage, typed failures; `optimize-schema.ts` (`covMethod`, min ≤ max); `api.ts` (400 with code); `mcp.ts` (code and suggestion in the error); `advisor.ts` (typed issue).
- `src/server/services/portfolio.ts`, `src/app/(app)/analytics/page.tsx` — analytics MPT uses N from data and shows covariance warnings.
- UI: `src/components/OptimizerClient.tsx`, `src/components/charts.tsx`, `src/app/(app)/optimizer/page.tsx`.
- Tests: new `src/lib/finance/optimizer-pr3.test.ts` (17).

## 5. Migration impact

No database change. Optimizer outputs change: the calendar now uses only common dates, N comes from the data, and historical E[R] is the arithmetic mean × N instead of (1 + mean)^252 − 1. Saved allocation targets are not touched.

## 6. Verification (actual results)

| Command | Result |
|---|---|
| `npx vitest run src/lib/finance/optimizer-pr3.test.ts` on the PR 2 code | 17 failed / 0 passed (17) |
| `npm test` | 9 files, **133 passed** |
| `npm run lint` | No ESLint warnings or errors |
| `npx tsc --noEmit` | 0 errors |
| `npm run build` | success |
| REST `POST /api/v1/portfolio/optimize` with 3 symbols, max 20% | 400 `INFEASIBLE_BOUNDS` with a suggestion |
| MCP `optimize_portfolio`, same input | `isError: true` with the code and suggestion |
| REST optimize, all assets, max 40% | weights within 0–40%, Σw = 1, solver optimal |
| Browser: optimizer (normal, and max 10% with 6 assets) and analytics | rendered; infeasible state shows the reason and no weights; no console errors |

## 7. Open issues

- Rebalance trade list ignores lot size, fees, minimum trade and tax (spec E4, optional).
- EWMA covariance, Black–Litterman and stress tests are not implemented (E5); per-asset return override provenance (source/date/uncertainty) belongs to PR 5.
- Asset-class optimizer with fund look-through (E6) is not implemented. "ใช้เป็นเป้าหมาย" still aggregates asset weights by class.
- Analytics page MPT still uses the simplex-projection solver (long-only [0,1], no relaxation path); it could share the new QP in a later cleanup.
- Next: PR 4 (bond conventions), PR 5 (assumption governance).
