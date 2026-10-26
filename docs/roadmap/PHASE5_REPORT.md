# Phase 5 — Walk-forward backtesting: report

## Gap mapping
| Requirement | Done in | Reuse |
|---|---|---|
| Strategies: buy and hold, equal weight, minimum variance, max Sharpe, Black–Litterman, custom | `src/lib/finance/backtest.ts` | `recommend` (QP), `blackLitterman` |
| Walk-forward steps 1–8 | `backtest()` | `estimateInputs`, `ledoitWolf`, `beta`, `rebalance` (trades and costs) |
| No look-ahead | The window ends at price t − 1; trades at the close of day t | Test: perturbing future prices leaves earlier decisions unchanged |
| Survivorship bias | Disclosed in `limitations`; assets without full history are excluded and listed | — |
| Metrics (CAGR, vol, Sharpe, Sortino, MDD, α, β, TE, IR) | `computeMetrics` (unchanged) | Same engine as the Performance page |
| Turnover and cost attribution | New, small (in `backtest()`) | Cost breakdown from `tradeCost` |
| Frontend | `/backtest` page | `GrowthChart`; new `DrawdownChart`, `WeightsChart` |
| MCP `backtest_portfolio` | `services/backtest.ts`, compact summary in `backtest-summary.ts`; advisor; REST `POST /api/v1/portfolio/backtest`; OpenAPI | — |

No database changes. Read-only: the transaction count was unchanged (17).

## Verification
- Tests: 280 pass (10 backtest tests, 2 end-to-end workflow tests). tsc, lint and build are clean.
- Local data, 6 assets from 2024-10-29 to 2026-10-26, quarterly:
  - Buy and hold +25.5%; equal weight +25.1% (Sharpe 1.08).
  - Minimum variance and max Sharpe (one-year window, trading from 2025-10-17): +3.2% and +4.3%.
- With costs of 0.157% / min 50 / VAT 7% / 10bp, monthly equal weight paid 10,786 THB (1.08% of capital) and turnover was 89% a year.
- Custom weights left 10% in cash as specified.
- Black–Litterman with a GOLD view tilted toward GOLD (0.10 → 0.37).
- MCP `backtest_portfolio` returned a compact summary.
- Browser: run, the 4-strategy comparison, charts, trade history and limitations rendered with no page errors.
