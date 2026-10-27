# Strategies Phase 3 (factors) and Phase 4 (bond ladder)

Status: IMPLEMENTED.

## Phase 3 — Factor signals (`src/lib/finance/factor-strategies.ts`, model v1.0.0)

| Family | Sub-signals | Source (point-in-time) |
|---|---|---|
| value | Earnings yield (EPS ÷ price), book / price (equity ÷ shares ÷ price), margin of safety (median of the latest valuation per method ÷ price − 1) | Statements with `published_at` ≤ cutoff; valuations **created** ≤ cutoff (today's DCF is never used in the past); per-share figures moved to the latest share basis |
| quality | ROE, CFO / net income, net debt / EBITDA (lower is better), FCF stability | `dividend-metrics.qualityMetrics` (financial-sector rules reused) |
| momentum | 12–1 month return P(t−1m) / P(t−12m) − 1, optional ÷ 12-month volatility | Prices ≤ cutoff; both prints within 10 days of the target dates; split-consistent (latest-basis closes) |
| dividend | Regular TTM yield, consecutive paying years | `dividend-metrics` |

**Scoring:**
- Sub-signals get percentile ranks, either absolute or within a sector (`sectorNeutral`; a sector with a single member ranks 0.5, noted).
- Family score = mean of the available sub-ranks, with coverage reported.
- `multi_factor` = user-weighted families, renormalized over families with data. `minCoverage` excludes thin candidates.
- Each result returns the standalone factor picks for comparison, plus `factorDataCoverage`.
- `holdBuffer` keeps a previous pick while its rank is ≤ topN + buffer (turnover control in backtests).

**Weights:** equal or score, with caps by asset, issuer and sector (`capWeights`) and a cash reserve. Orders go through the existing `rebalancePortfolio`.

**Surfaces:**
- `/factors` page (`FactorStrategyPanel`)
- `POST /api/v1/strategies/factors`
- MCP / advisor `screen_factor_stocks`
- `backtest_portfolio` strategies `value | quality | momentum | multi_factor`, through the same decision provider as Phase 1

**Backtest point-in-time rules:**
- Value / quality refuse with `NOT_BACKTESTABLE_NO_ASOF_DATA` when the statements in the universe lack `published_at` (strict mode). Illustrative mode is labelled as look-ahead biased.
- Momentum needs prices only.

## Phase 4 — Bond ladder (`src/lib/finance/bond-ladder.ts`)

- Rung k = bonds maturing in (k − 1, k] years (0.01-year tolerance for day-count leap days).
- Each rung gets budget ÷ rungs, split equally inside the rung, then issuer caps.
- Purchases are whole units at the dirty price (clean + accrued). Empty rungs stay in cash and are reported (not redistributed).
- Filters:
  - minimum rating (AAA … D scale)
  - maximum 1-year PD from the credit profile's survival function
  - an unrated toggle (missing credit data never passes a credit filter)
  - stale price (> N days)
  - maturity outside the ladder
- Output:
  - holdings with clean/dirty price, YTM, modified duration and DV01
  - coupon vs principal cashflows by payment year
  - portfolio XIRR on dirty cost
  - value-weighted duration and total DV01
  - an optional reinvestment scenario at an assumed rate
- Reused: `analyticsFromPrice` / cashflow schedule, `survivalFunction`, `xirrDetailed`, `capWeights`.
- **No historical backtest:** the app has no reliable historical executable bond quotes, so the output is a forward scenario only (stated in the methodology).
- Surfaces: Bonds page section (`BondLadderPanel`, `LadderCashflowChart`), `POST /api/v1/bonds/ladder`, MCP / advisor `plan_bond_ladder`, OpenAPI.

## Verification

- `factor-strategies.test.ts` (9):
  - 12–1 skips the latest month; insufficient history gives `insufficient` (never 0)
  - split-adjusted EPS / BVPS; currency mismatch
  - momentum ranking and exclusions
  - value / quality ranking with a documented tie
  - multi-factor = weighted families (deterministic)
  - sector-neutral ranks; hold buffer; null signals
- `bond-ladder.test.ts` (6):
  - par bonds: YTM = coupon, 200 units per rung, principal by year
  - coupon on the settlement date belongs to the seller
  - empty rung → cash; issuer cap
  - credit filters (rating / PD / unrated / no PD)
  - stale and outside-ladder exclusions; reinvestment scenario
- **Runtime (local):**
  - The factor screen marks partial coverage honestly (value 1/4, quality 0/4: no statements locally).
  - The momentum backtest holds cash until 12 months of prices exist.
  - The value backtest holds cash throughout, because the valuations were created after every decision date (no look-ahead).
  - Ladder with LB29DA: rung 4, 4 empty rungs reported, XIRR 2.16% vs YTM 2.15%.
  - Browser pages show no errors.
- **Gates:** `npm test` 409/409, typecheck, lint, build — all PASS.
