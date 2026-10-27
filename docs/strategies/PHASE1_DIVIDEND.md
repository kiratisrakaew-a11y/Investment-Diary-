# Strategies Phase 1 — Dividend investing

Status: IMPLEMENTED (gates below). Base HEAD `8c065cd`, branch `claude/vigilant-fermi-tf3wq7`.

## 1. Files

| Kind | File | Why |
|---|---|---|
| NEW (pure) | `src/lib/finance/dividend-metrics.ts` | Per-security dividend metrics with status/methodology/provenance. Nothing equivalent existed |
| NEW (pure) | `src/lib/finance/dividend-strategies.ts` | 3 versioned presets, filters, percentile scoring, weights/caps, point-in-time helpers |
| NEW (pure) | `src/lib/finance/dividend-income.ts` | Income calendar (announced / estimated / received / missing_confirmation) |
| NEW (service) | `src/server/services/dividends.ts` | Authoritative issuer dividend-event store (idempotent, revisions) and Yahoo import |
| NEW (service) | `src/server/services/strategies.ts` | One orchestration service for UI, REST, MCP and advisor (no backtest clone) |
| NEW (UI) | `src/app/(app)/dividends/page.tsx`, `DividendStrategyPanel.tsx`, `DividendEventsPanel.tsx` | Dividend page within the existing navigation |
| NEW (REST) | `api/v1/dividends/{screen,income,events,import}` | Thin routes over the shared services |
| EXTEND | `lib/finance/backtest.ts` | Optional `decisionProvider` and `dividendCashflows` (no fork); `assertSingleDividendTreatment` |
| EXTEND | `services/backtest.ts` | `dividend_*` strategies, `pointInTime`, `dividendCashflows`, `reinvestDividends`, `paymentLagDays`, `withholding` |
| EXTEND | `services/price-sync.ts` | Persists Yahoo dividend events on a real (non-dry-run) sync |
| EXTEND | `services/statements.ts`, MCP/REST `save_financial_statements` | Optional `publishedAt` per fiscal year |
| EXTEND | `services/portfolio.ts` | `holdingsAt(dates)` — ledger replay, read-only |
| EXTEND | `RebalancePanel.tsx` (`sourceLabel`), `BacktestClient.tsx`, `charts.tsx` (`IncomeChart`), `Nav.tsx`, `mcp.ts`, `advisor.ts`, `openapi.ts` | Surfaces |
| REUSED unchanged | `rebalance.ts`, `optimizer.ts` / `recommend.ts` (via `optimizePortfolio`), `metrics.ts`, `return-series.ts`, `exposure.ts` | Order sizing, min-variance weights with caps, performance metrics, return conventions |

## 2. Data model and migration

- Migration `drizzle/0011_strategies_dividend_events.sql` (additive only):
  - New table `dividend_events`, unique on (`source`, `source_event_id`), indexed by (`symbol`, `ex_date`).
  - Nullable `financial_statements.published_at`.
- Fields per event: declaration / ex / record / payment dates (each nullable), DPS, currency, cash or stock, kind (`regular | special | indicated_annual | unknown`), fiscal period, source, retrieved_at, announced_at, data-quality status, split-adjustment policy, withholding rate and source, note, and `revisions`.
- Corrections keep the previous values in `revisions`. Re-sending the same event changes nothing (verified: 35 inserted, then 0/0/35 on the second call).
- Yahoo events carry an ex-date and an amount only. They are stored with `kind = unknown`, `splitAdjustmentPolicy = provider_split_adjusted`, `announced_at = null`. Nothing is inferred.
- **Rollback:** `DROP TABLE dividend_events; ALTER TABLE financial_statements DROP COLUMN published_at;` and remove the 0011 journal entry. No existing row is modified by the migration.

## 3. Formulas (decimals internally)

| Metric | Definition | Status rules |
|---|---|---|
| TTM yield | Σ cash DPS with ex-date in (asOf − 12m, asOf], on the latest share basis ÷ price at asOf. Total vs regular; special dividends toggle total only | Price missing or currency mismatch → `unavailable`. `kind unknown` → `partial` (counted as regular, warned). Stock dividends are not cash |
| Share basis | `as_reported` DPS ÷ Π(split ratios effective after the ex-date) | Prices are stored on the latest basis, so yields are continuous across splits |
| Forward yield | Declared `indicated_annual` rate known by asOf ÷ price | `unavailable` when only past dividends exist |
| Earnings payout | DPS ÷ basic EPS, same fiscal year (fallback: dividends paid ÷ net income, `partial`, timing warning) | EPS ≤ 0 → `not_meaningful` |
| FCF payout | Dividends paid ÷ (CFO − CapEx), same fiscal year | FCF ≤ 0 → `not_meaningful` plus a risk flag. Financial sector → `not_meaningful` |
| Coverage | EPS ÷ DPS; FCF ÷ dividends paid | Zero dividends → `not_meaningful` |
| DPS CAGR 3/5/10 | (DPS_end ÷ DPS_{end−n})^(1/n) − 1, exact years | Missing start year → `insufficient`; non-positive → `not_meaningful` |
| Annual DPS series | Statement DPS (≥ 2 years), else calendar-year sums of regular events for completed years (a year inside the history with no event = 0) | Source reported |
| Consistency | Consecutive latest years with DPS > 0; cuts; missed years | Statement gaps = unknown, not zero |
| Yield vs own history | Percentile of the current TTM yield among month-end TTM yields (≥ 24 obs.) | Price −25% in 12m with percentile ≥ 0.8 → `priceDropFlag` (excluded by default; never rewarded) |
| Quality | ROE (average equity), ROIC, net debt / EBITDA, EBIT / interest, CFO / net income, FCF stability (5y), debt / equity | Banks / insurers: industrial ratios `not_meaningful` |
| Total shareholder yield | — | `unsupported` (no buyback data) |

**Scoring:**
- Filters with editable thresholds. A filter whose metric is missing excludes the stock (`insufficient_data`). Nothing is selected from missing fields.
- Factor score = cross-sectional percentile rank (ties averaged; lower-is-better factors negated).
- Composite = Σ wᵢ·rankᵢ ÷ Σ w over the available factors. Coverage is reported. Required factors are never imputed; coverage below `minCoverage` excludes the stock.
- Tie-break: score ↓, regular yield ↓, symbol ↑.
- Weights:
  - equal, score, or the existing optimizer (minimum variance with the same caps)
  - asset, issuer and sector caps via iterative capping; any remainder goes to cash, with a note
  - cash reserve
  - orders via the existing `rebalancePortfolio` (proposal only)

Presets are `v1.0.0`. All weights and thresholds are illustrative and editable.

## 4. Backtest (no look-ahead)

- **Decision at t uses data up to t − 1 only:**
  - Events count if their ex-date is ≤ cutoff (necessarily public by then) or their `announced_at` is ≤ cutoff.
  - Statements count only if `published_at` ≤ cutoff.
  - Valuations count only if created ≤ cutoff (median of the latest per method).
- **Readiness check:** strict mode with statement-based factors and no `published_at` → `NOT_BACKTESTABLE_NO_ASOF_DATA`. `illustrative_lookahead` runs but is labelled biased. Events-only settings need no statement dates.
- **One economic treatment:** tradable closes (split-adjusted, not dividend-adjusted) plus cash events. `total_return` together with dividend cashflows is rejected (double count).
- **Cashflows:**
  - Entitlement on the ex-date from units held at the previous close; buying on the ex-date earns nothing that time.
  - Cash arrives on the payment date. Between the two dates the amount is a receivable included in NAV.
  - Withholding: the event rate, else an assumption by asset class (editable). USD is converted at USDTHB on the payment date.
  - Optional reinvestment buys toward the last target (buys only, with costs).
  - Events without a payment date are not credited unless `paymentLagDays` is set (labelled as an assumption).
- **Reports:**
  - gross, withholding, net received, receivable at end, reinvested, events, entitled events
  - income return vs price-and-other return; income by year
  - per-decision selections and exclusions
  - a benchmark-type warning: a price index is not total return

## 5. Verification

**Tests:** `dividend-metrics.test.ts` (16), `dividend-strategies.test.ts` (8), `dividend-income.test.ts` (6), `backtest-dividends.test.ts` (11), `explain-data` (existing), `mcp.test.ts` (4 new tool names). All acceptance cases from spec §4.7 are covered:
- 4/100 = 4%; split basis.
- Payout 4/8 = 50%; EPS ≤ 0 → `not_meaningful`.
- FCF 120 − 40 = 80 → 40%.
- CAGR (3.2/2)^(1/5) − 1.
- Forward yield unavailable from past dividends only.
- Special-dividend toggle.
- Missing as-of dates → NOT_BACKTESTABLE.
- Ex-date entitlement and payment-date cash.
- No double credit with total return.
- Split continuity; withholding plus FX.
- Missing fields → `unavailable`.
- The income plan is pure: it does not write the ledger. Verified at runtime: the dividend transaction count was unchanged (2) after income plans and backtests.
- REST and MCP give identical scores, weights and exclusions for the same settings (runtime comparison).
- Regression: the built-in strategies are unchanged — the equal-weight backtest is still +25.08% on local data, and an empty cashflow list leaves values identical (test).

**Runtime checks (local PG16, `next dev`):**
- Yahoo import: network blocked in this environment → per-symbol `fetch failed`, reported, nothing written.
- Test events (`TEST-LOCAL`) and statements with `published_at` were inserted via REST, then deleted afterwards.
- Screener, income plan, strict and illustrative backtests, and the double-count refusal were exercised via REST, MCP and the browser.

**Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` — results in the commit message and the final report.

## 6. Limitations

- The universe is the user's assets (survivorship). No liquidity data, so the liquidity filter is `unsupported`.
- Yahoo has no payment, declaration or regular-vs-special information. Statement DPS may include special dividends (not separable).
- Statement basis (consolidated / separate) is not stored per year. EPS is basic, not diluted.
- Estimated income repeats last year's regular dividends. It is not a forecast of the company.
- Lot sizes in backtests use today's share basis.

## 7. Next phase blockers

None from Phase 1. Phase 2 (risk parity, minimum CVaR, maximum diversification) needs:
- a small dedicated nonlinear routine (ERC)
- an LP solver (CVaR), since the existing QP needs a positive-definite G
