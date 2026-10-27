# Investment strategy extension — final report

| | |
|---|---|
| Branch | `claude/vigilant-fermi-tf3wq7` |
| Base (audited) | `8c065cd` |
| Deployment | **NO.** Nothing deployed; no orders; no transactions created by any strategy, simulation or income plan |

## Phases

| Phase | Status | Commit | Doc |
|---|---|---|---|
| 0 Audit | DONE | `2530f42` | `PHASE0_AUDIT.md` |
| 1 Dividend investing (P0) | DONE | `2f40805` | `PHASE1_DIVIDEND.md` |
| 2 Risk parity / min CVaR / max diversification | DONE | `0936b7f` | `PHASE2_RISK_BASED.md` |
| 3 Factor strategies | DONE | this commit | `PHASE3_4_FACTORS_LADDER.md` |
| 4 Bond ladder (forward scenario) | DONE | this commit | `PHASE3_4_FACTORS_LADDER.md` |

## Migrations

`drizzle/0011_strategies_dividend_events.sql` — additive only:
- new table `dividend_events`
- nullable `financial_statements.published_at`

**Rollback:** drop that table and column, and remove the journal entry. No existing row is changed.

The `vercel-build` script runs migrations, so the next deploy applies 0011 automatically.

## New or changed tools (connector refresh needed)

| Kind | Tools |
|---|---|
| New | `screen_dividend_stocks`, `get_dividend_income`, `record_dividend_event`, `list_dividend_events`, `screen_factor_stocks`, `plan_bond_ladder` |
| Extended | `backtest_portfolio` — 10 new strategies, `pointInTime`, `dividendCashflows`, `reinvestDividends`, `paymentLagDays`, `withholding`, `cvarConfidence`, `factorSettings`, `dividendSettings` |
| Extended | `optimize_portfolio` — `risk_parity` / `max_diversification` / `min_cvar`, `riskBudgets`, `cvarConfidence`; output `riskBased` |
| Extended | `save_financial_statements` — `publishedAt` per year |
| Extended | `sync_historical_prices` — now also stores Yahoo dividend events |

**REST:**
- `/api/v1/dividends/{screen,income,events,import}`
- `/api/v1/strategies/factors`
- `/api/v1/bonds/ladder`

OpenAPI is updated for all of them.

## Verification (final)

| Command | Result |
|---|---|
| `npm test` | PASS — 40 files, 409 tests (baseline 334) |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS |

**Regression:** the built-in backtests are unchanged (equal weight +25.08% on local data); the existing optimizer objectives return no `riskBased` field; empty dividend cashflows leave backtest values identical.

**Parity:** REST and MCP screening return identical scores, weights and exclusions for the same settings.

## No duplicated engines

- Backtest: one engine, extended with a decision provider and cashflows.
- Costs and lots: `rebalance.ts`.
- QP: `solveGeneralQP` (max diversification).
- Risk metrics: `expectedShortfall`, RC definition.
- Valuation: saved valuations only.
- Bonds and credit: `bonds.ts`, `credit-risk.ts`.
- Return conventions: `return-series.ts`; total return and dividend cash cannot be combined.

The only new solver is the narrowly scoped LP needed for CVaR.

## Known limitations / data gaps

- Yahoo dividend data has no announcement or payment dates and no regular/special flag. This network blocks Yahoo, so local testing used labelled test events (deleted afterwards).
- Point-in-time fundamentals need `published_at` on statements. Without it, statement-based backtests are refused (or run in a labelled illustrative mode).
- Universe = the user's assets (survivorship). No volume data → no liquidity filter. No buyback data → no shareholder yield.
- Risk parity does not take per-asset or group bounds (refused, never clipped).
- The bond ladder is a forward scenario; there is no historical bond backtest.
- Tested on desktop and mobile layouts; not deployed.
