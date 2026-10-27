# Phase 0 — Baseline verification (before any v3 change)

- Branch `claude/vigilant-fermi-tf3wq7`, HEAD `1c0ab342f2e184553c1c13dd57291721598c551b` (matches the spec baseline).
- Environment: Node v22.22.0, npm 10.9.4, local PostgreSQL 16. No outbound market-data access from the sandbox (Yahoo / SEC fetches cannot be exercised live).

| Command | Result |
|---|---|
| `npm test` (vitest run) | **FAIL** — 277 passed, 1 failed: `backtest.test.ts > costs are deducted and attributed; turnover reported` timed out at 5,000 ms. It passes with `--testTimeout 60000` in 5,095 ms. All other 9 backtest tests take < 60 ms. |
| `npm run typecheck` (tsc --noEmit) | PASS (exit 0) |
| `npm run lint` | PASS — "No ESLint warnings or errors" |
| `npm run build` | PASS — "Compiled successfully" |

The failure is a real defect, not a flaky test (FIX-1 in `00_CURRENT_GAP_AUDIT.md`). In fractional mode the backtest passes lot = 1e-6 to `rebalance()`; with costs, its local search moves 1e-6 units per step, for up to 5,000 rounds per rebalance.
