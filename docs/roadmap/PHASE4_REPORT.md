# Phase 4 — Rebalancing & risk: report

## Gap mapping
| Requirement | Done in | Reuse / new |
|---|---|---|
| Cost-aware rebalancing, `rebalance_portfolio` | `src/lib/finance/rebalance.ts`, `src/server/services/rebalance.ts`; REST `POST /api/v1/portfolio/rebalance`; optimizer-page panel with editable target weights | Holdings, cash and prices from `buildSnapshot`; targets from `optimizePortfolio`; covariance from `loadUniverse`. New: lots, costs, cash and turnover search (the QP cannot do integers or fees) |
| Trading costs in Settings | `settings.trading_costs` (jsonb) and `assets.lot_size`; migration `0008` (additive, defaults 0 / thai_stock lot 100) | Settings page form |
| Risk contribution, MCTR, concentration, component ES | `risk-contribution.ts`; analytics page; `optimize_portfolio.risk` | Covariance and the `expectedShortfall` definition reused; no new VaR/ES formula |
| Robust: bootstrap, return sensitivity, weight stability | `robust.ts`; `optimize_portfolio.robust` | Same `recommend` QP; `ledoitWolf` reused |
| Stress test, `stress_test_portfolio` | `stress.ts`, `services/stress.ts`; REST `POST /api/v1/portfolio/stress`; analytics page panel | β from `loadUniverse`; duration and convexity from `bondHoldings` |
| Sector shock | Partial: user-defined groups | No sector data (DEFER from Phase 0) |

Proposed trades are never recorded: the transaction count was the same before and after all tests (17 → 17).

## Verification
- Tests: 258 pass. New tests:
  - Costs formula, lots, cash ≥ reserve, min trade, turnover cap, no-trade band, kept holdings, min_cost ≤ track cost, full exit on 0% (including the hedge case), missing price, targets > 100%, TE decreases.
  - Euler Σ RC = σ, the equal-risk closed form, component ES sums to ES.
  - Stress formulas (β, duration and convexity, compounded FX, groups, overrides, haircut, correlation σ closed form), worst day/window.
  - Bootstrap determinism, bounds, monotone return sensitivity.
  - The MCP contract lists both new tools.
- tsc, lint and build are clean; migration applied locally.
- Local server with a sample cost model (0.157% / min 50 / VAT 7% / 10bp / min trade 1,000):
  - Rebalance from the optimizer: whole lots, costs matching the formula, end cash ≥ 0, TE 16.9% → 0.07%.
  - Custom weights, buy-only with a 2% band: only affordable whole lots.
  - Targets > 100% rejected.
  - Stress presets and a custom scenario, via REST and MCP.
  - Robust: 40 draws, 0 failed.
- Browser:
  - Settings cost form saved.
  - Optimizer panel pre-filled from the optimizer, edited and reset; trade list shown with the "proposal only" note.
  - Analytics risk-contribution table and stress panel; no page errors.
- Test settings were reset to `{}` afterwards.
