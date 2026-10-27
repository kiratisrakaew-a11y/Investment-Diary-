# Strategies Phase 2 — Risk-based portfolios

Status: IMPLEMENTED.

## Files

| Kind | File | Why |
|---|---|---|
| NEW (pure) | `src/lib/finance/risk-strategies.ts` | ERC/risk budgeting (Newton), maximum diversification (via the existing QP), minimum CVaR, and `solveLP` — a narrowly scoped dense two-phase simplex. The existing QP needs a positive-definite G, so it was not altered to imitate an LP |
| EXTEND | `recommend.ts` | Objectives `risk_parity`, `max_diversification`, `min_cvar`; `riskBased` report. The existing objectives are untouched (test) |
| EXTEND | `backtest.ts`, `services/backtest.ts` | The same three strategies in the walk-forward engine (training window only; `cvarConfidence`) |
| EXTEND | `optimize-schema.ts`, `services/optimizer.ts` | `objective` enum, `riskBudgets`, `cvarConfidence`; min CVaR uses `loadUniverse` series (no new loader) |
| EXTEND | `OptimizerClient.tsx`, optimizer page, `BacktestClient.tsx`, MCP/advisor descriptions | Surfaces |
| REUSED | `solveGeneralQP`, `covarianceDiagnostics`, `riskReport` logic (same RC definition as `risk-contribution.ts`), `expectedShortfall`, `rebalance` | No duplicated risk math |

## Methods

- **Risk budgeting:**
  - Spinu's convex problem min ½yᵀΣy − Σ bᵢ ln yᵢ, solved by Newton with Armijo backtracking (keeping y > 0).
  - w = y / Σy gives RCᵢ / σ_p = bᵢ. Reports the gradient residual, iterations and the maximum share deviation.
  - Zero-volatility assets are `invalid`.
  - Per-asset bounds and group constraints are **not** imposed: a violation returns `INFEASIBLE_CONSTRAINTS` / `UNSUPPORTED_CONSTRAINT`, never clipped weights.
- **Maximum diversification:**
  - z = D y turns max σᵀw / √(wᵀΣw) into min zᵀCz s.t. Σz = 1 (C = correlation).
  - Weight bounds and linear (issuer / sector) constraints become homogeneous linear rows. Long-only only.
- **Minimum CVaR (Rockafellar–Uryasev):**
  - min ζ + Σuₜ / ((1 − α)T) with uₜ ≥ −rₜᵀw − ζ, uₜ ≥ 0. Supports box bounds, per-asset bounds, linear constraints and an optional minimum return.
  - At the optimum the LP objective equals `expectedShortfall` (fractional tail) of the resulting weights. This is tested, and checked at runtime (0.18952930% both ways on local data).
- **LP solver:**
  - Dantzig pricing, switching to Bland's rule after 50 degenerate pivots.
  - Existing unit columns form the starting basis.
  - Reports infeasible / unbounded / iteration limit.
  - Beale's cycling example terminates at −1.25.
  - About 0.4–0.6 s for 10 assets × 500 days.

## Verification

- `risk-strategies.test.ts` (12): LP textbook / phase I / infeasible / unbounded / Beale; ERC with diagonal and correlated covariance and budgets; MDP vs brute-force grid (free and capped); CVaR = ES, CVaR vs grid, minimum return, short sample.
- `risk-objectives.test.ts` (7): recommend() for each objective, refusals, existing objectives unchanged, backtest runs, and risk-parity weights at a rebalance equal risk parity on that window's covariance (no look-ahead).
- Runtime (local, production build):
  - MCP `optimize_portfolio`: risk shares 1/6 each for risk parity; the 40% cap is refused with a reason.
  - REST backtests for all three.
  - Optimizer page in the browser.
- Gates: `npm test` 394/394, typecheck, lint, build — all PASS.

## Limitations

- Risk parity does not support bounds or groups (reported). Expected returns are ignored by design.
- CVaR is historical, per observation period, and assumes the window represents the future.
- No turnover cap inside the optimization. Use `rebalance_portfolio` `maxTurnover`.
