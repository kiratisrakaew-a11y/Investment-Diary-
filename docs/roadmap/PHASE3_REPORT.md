# Phase 3 — Optimization: report

## Gap mapping
| Requirement | Done in | Reuse / decision |
|---|---|---|
| Historical / CAPM / blend | unchanged (`expectedReturns`) | kept |
| Black–Litterman | `src/lib/finance/black-litterman.ts`; `returnMethod: "black_litterman"` + `blackLitterman` in `optimize-schema.ts` (validated only for that method) | No new tool: `optimize_portfolio` (MCP, advisor, REST `POST /api/v1/portfolio/optimize`, OpenAPI) |
| Shared optimizer | Posterior μ (and optionally Σ_post) passed to the existing `recommend` → `optimizer.ts` QP | No new solver, frontier or covariance engine |
| Duplicate solver (Phase 0 FIX) | `getMptAnalysis` and the `mpt.ts` exports now use `optimizer.ts`; the projected-gradient solver was removed | Old exports kept as wrappers |
| Prior vs posterior, weight comparison | `optimizePortfolio` → `blackLitterman.assets` / `views` / `weights`; optimizer page panel and table | Same constraints for the prior and posterior runs |
| Sector / group limits | DEFER | No sector data on assets, and the QP supports box and budget constraints only — needs a schema field and general linear constraints in the solver |

Market weights are never taken from holdings. A missing weight is an error naming the assets; the page has an explicit "equal weights" button.

## Verification
- Tests: 241 pass (8 Black–Litterman tests, 1 engine-consolidation test). tsc, lint and build are clean.
  - Π = δΣw, and reverse optimization recovers w.
  - The posterior and posterior covariance equal the Theil mixed-estimation form to 1e-10.
  - One-asset 50% confidence gives the average of Π and Q; 100% confidence makes the view hold exactly; ≈0% leaves the prior.
  - An explicit Ω is used as given; uncorrelated assets are unaffected; relative views do not depend on Rf.
  - Implied δ recovers the ERP; validation errors work.
  - With no views, the existing optimizer returns the market weights.
  - The legacy MPT exports give the same weights as the QP (the existing closed-form tests still pass).
- Local server (6 assets, 2 years):
  - REST BL with no views: δ implied 4.55, and the recommended weights equal the market weights exactly.
  - With an absolute view (PTT 15%, 70%) and a relative view (GOLD − AAPL 3%, 50%): posterior returns moved toward the views and PTT's weight rose from 0.20 to 0.35 (max 50%).
  - Missing weights gave INVALID_INPUT naming the assets; a missing `blackLitterman` gave a 400.
  - Optimizer page: the BL panel, views, prior/posterior and weight comparison rendered with no page errors. The analytics page renders the frontier from the QP engine.
