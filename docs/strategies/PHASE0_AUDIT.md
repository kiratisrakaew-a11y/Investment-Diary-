# Strategy extension — Phase 0 audit (latest HEAD)

| | |
|---|---|
| Branch | `claude/vigilant-fermi-tf3wq7` |
| HEAD audited | `8c065cdd3de3e1585ad77db2cf65207a2dc7e361` (same as the spec's reference tree) |
| Baseline | `npm test` **PASS** 32 files / 334 tests · `npm run typecheck` **PASS** · `npm run lint` **PASS** · `npm run build` **PASS** |

## 1. Strategy surface today

| Item | Where | Notes |
|---|---|---|
| `BacktestStrategy` | `src/lib/finance/backtest.ts` | `buy_and_hold \| equal_weight \| min_variance \| max_sharpe \| black_litterman \| custom`. Target weights come from one internal `decide(t)` closure |
| Backtest service | `src/server/services/backtest.ts` `backtestPortfolio` | Loads prices, FX, benchmark and settings costs; `returnBasis` price/total via `return-series.ts` |
| Optimizer objectives | `src/lib/finance/recommend.ts`, `optimizer.ts` | `max_sharpe`, `min_variance`, target return/vol, utility; general-constraint QP (v3 Phase 3) |
| Rebalance | `src/lib/finance/rebalance.ts`, `services/rebalance.ts` `rebalancePortfolio` | Proposal only; lots, costs, cash reserve, turnover cap |
| UI | `/optimizer` (`OptimizerClient`, `RebalancePanel`), `/backtest` (`BacktestClient`) | No dividend or strategy-screener screen |
| REST / MCP / advisor | `optimize_portfolio`, `rebalance_portfolio`, `backtest_portfolio`, `stress_test_portfolio`, … in `mcp.ts`, `advisor.ts`, `openapi.ts`; `/api/v1/*` | No dividend tools |

## 2. Dividend records: investor receipts vs issuer events

| Record | State | Evidence |
|---|---|---|
| Investor cash dividends received | **EXISTS** | `transactions.type = 'dividend'`, `price` = total amount; the ledger credits cash and income (`portfolio.ts` `case "dividend"`). This is the source of truth for money received |
| Issuer dividend announcements / events | **NEW** | No table. Yahoo `chart(events: "div")` returns `{date (ex-date), amount}` in `lib/prices/yahoo.ts`, but `price-sync.ts` only turns them into a warning string (`corporateActionWarnings`) and **does not persist them** |
| Declaration / record / payment date, cash vs stock, regular vs special, withholding, announced-at | **NEW** | Yahoo gives none of these (ex-date + amount only, already split-adjusted to the current share basis). No other source in the app |
| Split history | **EXISTS** | `split` transactions (ratio in `quantity`) plus `adjustPricesForSplit` (`services/splits.ts`). Stored closes are on the latest share basis once repaired |

## 3. Financial statement fields (`financial_statements.data`, `lib/financials.ts`)

| Field | State |
|---|---|
| `eps` (basic), `dps` (declared for the fiscal year), `netIncome` (to owners), `cfo`, `capex` (positive), `dividendsPaid` (positive), `sharesOutstanding`, `totalDebt`, `cash`, `ebitda`, `ebit`, `interestExpense`, `totalEquity` | **EXISTS** |
| Diluted EPS | **missing** — basic EPS used and labelled |
| Statement basis (consolidated / separate) | Extracted by AI (`extractionSchema.statementBasis`) but **not stored per year** — **DEFER** (only disclosed) |
| `published_at` / known-at date | **missing** — fiscal-year label only → **EXTEND** (additive nullable column). Without it, fundamentals cannot be used in a point-in-time backtest |
| Buybacks / net share repurchases | **missing** → Total Shareholder Yield **DEFER** (not inferred from prices) |

## 4. Universe, sector, liquidity

| Item | State |
|---|---|
| Universe | Assets the user added (`assets`); no delisted identifiers → survivorship bias, always disclosed |
| Sector / issuer | User-maintained with source and date (v3 Phase 3), often empty |
| Liquidity (volume / traded value) | **not stored** → a minimum-liquidity filter is **unsupported** (reported, never guessed) |

## 5. Backtest gap for dividend investing

- `returnBasis: total_return` uses provider `adj_close`, which is a synthetic reinvested index: no cash, no ex/payment timing, and not a tradable per-share price.
- `price_return` ignores dividends entirely.
- Missing: event cashflows (entitlement on the ex-date from shares held before it, cash on the payment date, withholding, optional reinvestment) and point-in-time selection signals.

## 6. Requirement matrix

| Requirement | Class | Plan / reuse |
|---|---|---|
| Point-in-time dividend event store, idempotent upsert, revisions | **NEW** | `dividend_events` table (migration 0011) + `services/dividends.ts` |
| Persist Yahoo dividend events | **EXTEND** | `price-sync.ts` stores them with source `yahoo`, `announced_at = null`, `split_adjustment_policy = provider_split_adjusted` |
| Statement publication date | **EXTEND** | `financial_statements.published_at` (nullable) + optional `publishedAt` on save |
| Dividend metrics (TTM, forward, payout, FCF payout, coverage, CAGR, consistency, yield history, quality) | **NEW** | Pure `lib/finance/dividend-metrics.ts` |
| Total shareholder yield | **DEFER** | No buyback data |
| Screening presets, scores, filters, weights | **NEW** | Pure `lib/finance/dividend-strategies.ts`; caps via the existing `exposure.ts` / optimizer; orders via the existing `rebalancePortfolio` |
| Income calendar (announced / estimated / received / missing_confirmation) | **NEW** | `services/strategies.ts`; ledger read-only |
| Dividend backtest with event cashflows, no look-ahead | **EXTEND** | `backtest.ts` gains an optional decision provider and cashflow events (no fork); `services/backtest.ts` prepares the data |
| Minimum-liquidity filter | **NOT FEASIBLE** | No volume data → returned as `unsupported` |
| UI / REST / MCP / advisor | **EXTEND** | `/dividends` page; `screen_dividend_stocks`, `get_dividend_income`, `record_dividend_event`; `backtest_portfolio` strategies extended |

## 7. Duplicate-credit audit (existing tests)

- `return-series.test.ts` / `return-conventions.test.ts`: `total_return` with both `adj_close` and distributions is rejected (no double count).
- The ledger counts dividends only from `dividend` transactions. Event data added in Phase 1 never writes transactions (a test is added).
