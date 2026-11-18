# Changelog

## 2026-11-18 — Abnormal trading, phases 2–6: calculations, scan, tools, data quality
- Abnormal return (event study):
  - market model (OLS), Dimson (lags −1/0/+1) and market-adjusted;
  - estimation −250…−30, event −10…+10 trading days, ≥ 120 observations or an error with the reason;
  - AR / CAR with t-statistics, CAR sub-windows (run-up before the news, announcement) and volume z of the same days.
- Abnormal volume: mean-adjusted log turnover (Campbell & Wasley); raw volume with a warning when shares outstanding is missing.
- Daily scan of Thai stocks:
  - levels ปกติ / น่าสังเกต / ผิดปกติ with adjustable thresholds;
  - "ผิดปกติก่อน event X วัน" label;
  - XD and single-day-CAR notes;
  - days without enough index data are never flagged on returns.
- MCP tools: `run_event_study`, `get_abnormal_volume`, `scan_abnormal_trading`, `list_events`, `record_event`, `delete_event`, `set_shares_outstanding`; matching REST endpoints and OpenAPI entries.
- `get_data_quality` adds an abnormal-trading readiness check (no volume, no shares outstanding, history < 150 days, > 10% zero-volume days, no SET TRI) with per-stock detail.
  - The dashboard status can now show "warnings" for Thai stocks missing these inputs.
- Docs: `docs/abnormal-trading.md`. Checks: `npm run check:abnormal`.
- Read-only on existing data: no migration in these phases; prices and other computed figures unchanged.

## 2026-11-18 — Abnormal trading, phase 1: data
- Migration 0018 (additive):
  - `prices.volume` (nullable);
  - new tables `shares_outstanding` (effective-dated) and `stock_events`.
  - Manual rollback: `drizzle/rollback/0018_abnormal_trading.down.sql` (drops only what 0018 added).
- Volume:
  - `sync_historical_prices` stores Yahoo volume. On stored rows it fills volume only where it is empty, never changing close / adjusted close.
  - `import_prices` accepts a volume column, and `target: "benchmark"` for index series such as SETTRI (SET TRI).
- Shares outstanding: value as of each date, or null with a reason.
- Events: list includes XD dates from dividend data.
- Asset rename / cascade delete cover the new tables.
- No existing prices or computed figures change (verified by hash and parity).

## 2026-11-18 — Custom metrics on the asset price chart
- Asset page price chart: "+ เพิ่ม Metric ลงกราฟ" chips put custom metrics on a right-hand axis. Readings are dots on their own dates with threshold-status rings; nothing is filled between them.
  - The right axis takes one unit only, and only metrics within 10× of each other in magnitude; others are disabled with the reason.
  - The selection is remembered per asset in the browser.
- A correlation box shows Pearson r between the price return and the metric change over each interval between readings:
  - % units are measured in percentage points; other units as % change, or as a plain difference when the earlier value is ≤ 0.
  - The price is matched within 10 days, on either the data date or the published date.
  - No r is shown below 8 intervals; the reason and n are shown instead.
- Display only: no database change.

## 2026-11-18 — Faster Dashboard and Analytics
- Dashboard loads the price table / ledger / FX once and shares it across summary, allocation and performance (it was loaded three times). Analytics shares one load between performance and MPT.
- Measured locally: Dashboard 20 → 9 queries and 11,933 → 4,624 rows read; Analytics 12 → 7 queries and 7,995 → 4,307 rows read. Every computed figure is unchanged.
- `vercel.json` pins serverless functions to Singapore (`sin1`), the same region as the database.
- Read path only: no migration and no change to any write / delete code.

## 2026-11-18 — Analyst consensus target prices
- Stock valuation page: a "ราคาเป้าหมายนักวิเคราะห์ (Consensus)" card showing:
  - mean / median target, low–high range, number of analysts and rating;
  - upside vs the last stored close, source, as-of date and data age;
  - a "ดึงจาก Yahoo" button (press-only, no cron), manual entry with a cited source, and history.
- The football field gets a separate consensus row; it is not included in the user's averages.
- Valuation list: a Consensus column (target + upside, stale flag).
- "Latest found": when Yahoo has no data (`NO_COVERAGE`) or the request fails, nothing is overwritten and the latest stored consensus (any source) stays.
- MCP for Claude / ChatGPT: `get_analyst_consensus`, `refresh_analyst_consensus`, `record_analyst_consensus`, `delete_analyst_consensus`. `list_valuations` now returns `{ valuations, analystConsensus }`.
- REST + OpenAPI for ChatGPT Actions: `GET/POST /api/v1/valuation/consensus`, `POST …/refresh` and `DELETE …/:id`.
- Migration 0017 (new table `analyst_consensus`, additive).
- Asset rename carries consensus rows to the new symbol; cascade delete removes them.

## 2026-11-17 — Portfolio model comparison (Optimizer tab)
- New "เปรียบเทียบโมเดล" tab on the Optimizer page. It runs six models on one set of assets: Equal Weight, Min Variance, Max Sharpe, Risk Parity, Max Diversification and Min CVaR. All share the same calendar, weight bounds, costs and μ/Σ estimator.
- Train / test split: weights are estimated once on the training part. The table shows each model's weights, the ex-ante E[R] / σ / Sharpe, the realised in-sample fit, and the realised out-of-sample return / σ / Sharpe / max drawdown, with the gap between estimate and outcome.
- Walk-forward: weights are re-estimated at every rebalance. Every model now starts on the same day, so the test periods are identical.
- Out-of-sample wealth-index and drawdown charts, plus the methodology and limitations.
- REST `POST /api/v1/portfolio/compare-models` and MCP tool `compare_portfolio_models` (read-only).
- Engine: the backtest gains an optional `startIndex` and an exported `estimateWindow`.
- Fix: cash left a rounding error below zero after a rebalance could make the next rebalance fail once interest accrued. Existing backtest results are unchanged beyond rounding (≤ 1e-8).

## 2026-10-28 — Edit asset basics and permanent delete with related data
- New "ข้อมูลสินทรัพย์" section on the asset page.
  - Edit the symbol (e.g. AP → AP.BK, upper-cased automatically), name, type, currency, price source and price code.
  - The id never changes, so transactions, prices, metrics and notes stay attached. Valuations, financial statements, dividend events and statement uploads follow the new symbol.
  - Refused when the new symbol clashes with an existing asset, or when statements already exist under the new symbol.
  - Changing type or currency once transactions or prices exist needs a tick to confirm; stored values are not converted.
  - Every edit is audited.
- Permanent delete from the web now works for held or referenced assets.
  - The dialog lists what will be removed, and the symbol must be typed to confirm.
  - Removed in one transaction: transactions, prices, valuations, statements, dividends, uploads and custom metrics. Notes are kept but unlinked.
  - REST and MCP deletes keep the old guard (blocked when anything references the asset).

## 2026-10-28 — Custom metric charts: one chart per metric
- Every metric now has its own chart card in Actual, Indexed 100 and % Change, with its own y-axis, threshold bands (Actual only), tooltip and empty state. Metrics are no longer merged by unit or scale, and there are no dual axes. `actualLayout`, `unionRows` and `baseDateWarning` have been removed, replaced by `singleMetricChart` / `metricCharts`.
- The "connect missing dates" setting is honoured in every mode. Previously it was forced on for single-metric and small-multiple charts. Gaps longer than the metric's frequency allows stay visible when it is off.
- There are no schema, service, REST or MCP changes.

## 2026-10-28 — Custom Metrics via MCP
- 12 MCP tools for asset custom metrics (`list_asset_metrics`, `create_asset_metric`, `update_asset_metric`, `delete_asset_metric`, `record_metric_observation`, `update_metric_observation`, `delete_metric_observation`, `get_metric_history`, `list_metric_thresholds`, `preview_metric_threshold`, `set_metric_threshold`, `get_metric_series`). The asset is resolved by symbol and never auto-created. Every tool is a thin adapter over the existing service with source `mcp`, and read tools are marked read-only.
- MCP errors from metric tools now carry a machine-readable code (`Error: … [CODE]` plus a `{code, detail}` block). A zod validation error thrown inside any tool is now summarised as `path: message … [VALIDATION_ERROR]` instead of raw JSON. All other errors keep their existing text.
- Fix: a partial metric update (REST / UI / MCP) no longer resets `frequency` and `decimals` to their defaults. This was caused by zod v4 `.partial()` keeping `.default()`.
- `npm run check:mcp-asset-metrics`: end-to-end check through the real MCP server on disposable TEST-LOCAL assets.

## 2026-10-28 — Asset custom metrics with traffic-light thresholds
- New section on each asset page: user-defined metrics (e.g. NPL ratio), dated observations, latest summary with pp / unit / % change and freshness, history table, and a chart with Actual / Indexed 100 / % Change (no interpolation; small multiples for 3+ scales).
- Green / yellow / red thresholds (lower-is-better, higher-is-better, target range) with effective-dated versions; past observations keep the rule of their own date; impact preview before saving.
- Migration 0016 (four new tables), REST under `/api/v1/assets/:id/metrics…`, audit trail, and asset delete blocked while metrics exist. See `docs/ASSET_CUSTOM_METRICS.md`.

## 2026-10-27 — Financial model audit and hardening
- Audit published in `docs/FINANCIAL_MODEL_AUDIT.md`; fixes and evidence in `docs/FINANCIAL_MODEL_IMPLEMENTATION_REPORT.md`.
- Stress test: a long position's loss is floored at −100%. The linear figure and a warning are shown alongside, and factor lines are scaled to the floored total.
- VaR / ES by horizon (1 period … 5 years) from compounded returns. Shown only with enough independent history, with no √h extrapolation, plus THB amounts on the analytics page.
- Risk statistics (σ, Sharpe, Sortino, VaR) are computed on dates where every holding has an actual price. TWR and XIRR are unchanged.
- Monte Carlo correlation editor:
  - Independent or manual matrix, with symmetric editing and a locked diagonal.
  - PSD check; a repair is applied only after confirmation.
  - The matrix is no longer cleared when variables are edited.
- Bond calculator:
  - Bear/Base/Bull/custom scenarios with full repricing, weighted clean price and weighted horizon return. Kept on the page only and not saved.
  - Horizon return is split into coupon, reinvestment and price change.
- FCFE `netIncomeBasis` (optional), a single-stage RIM growth-consistency warning, and a Sortino MAR setting (migration 0015; empty = Rf).

## 2026-10-27 — PR11–PR15: scenarios, sensitivity, reverse DCF, Monte Carlo
- Every valuation method gets an optional `scenarioSet`: Bear/Base/Bull/Custom with allow-listed path overrides, Σp = 1 within 1e-8, and no silent normalisation.
  - `baseCaseValue` (unchanged meaning) and `probabilityWeightedValue` are separate fields.
  - Upside and margin of safety are reported per scenario, with a quality status (`preliminary` while material SOTP warnings remain).
- SOTP: each scenario reruns segment models and the whole bridge. Segments are targeted by stable id (new optional `id`; the editor assigns one when scenarios are added). `from_segments` turns the segment models' own Bear/Base/Bull into SOTP scenarios (the PLANB #31 gap).
- Generic sensitivity grid (≤ 121 cells, N/A with reasons), reverse DCF with bounded root search (`no_solution` / `ambiguous` reported), and seeded Monte Carlo (Gaussian copula, PSD check, invalid-draw accounting, ≤ 10,000 draws, time budget). Monte Carlo runs on the server.
- Editable Thai note per scenario in six sections. The analyst's text is never overwritten automatically, and a line diff is shown before replacing.
- Saved records:
  - The server recomputes `result.scenarioAnalysis` / `result.monteCarlo` with `inputHash`, and the editor flags a stale snapshot. Invalid probabilities refuse the save.
  - `intrinsicValue` stays the base value. Old records are unchanged.
  - The stock page shows the weighted value under the base value when present.
- API / MCP:
  - New REST endpoint `POST /api/v1/valuation/analyze`.
  - `/evaluate` and MCP `value_security` add `scenarioAnalysis` only when a scenarioSet is given.
  - New MCP tool `analyze_valuation`.
- `npm run check:scenario-parity` checks against the database and a running server: legacy record intact, refused invalid save, base vs weighted, notes, and REST / MCP parity with 401s without the key.
- No database migration: scenario data lives in the existing JSON columns.

## 2026-10-27 — PR9 + PR10: asset hide / archive / guarded delete
- Assets gain `hidden_in_holdings_at` and `archived_at` and a new `asset_lifecycle_events` log. Migration 0014 is additive.
- Typed results: `HIDDEN`, `ARCHIVED`, `RESTORED`, `DELETED`, `BLOCKED_HAS_DEPENDENCIES`, `FORBIDDEN`, `NOT_FOUND`. The server checks every rule again inside a transaction with a row lock, and the result is logged.
- **Hide** affects only the "other assets" chips on `/holdings`. It never changes accounting, prices, valuations or optimizer eligibility.
- **Archive** keeps all history. The asset is excluded from the optimizer universe (with a reason), the dividend universe, factor, backtest and transaction pickers, and the price form.
- Hide and archive are refused for a position still held.
- **Delete:**
  - Allowed only with zero transactions, prices, valuations, statements, uploads, dividend events and notes, and only when the exact symbol is typed.
  - It never cascades. The old one-click delete, which cascaded through transactions and prices, is removed.
- UI: a compact ⋯ menu on each chip with keyboard support, "ซ่อนไว้" / "เก็บถาวร" groups, and a delete dialog that requires the symbol to be typed.
- REST `GET/POST /api/v1/assets/{id}/lifecycle` returns 404 / 403 / 409 / 200. MCP adds `manage_asset_lifecycle`.
- `createAsset` on an existing symbol returns it unchanged, so imports and `add_asset` never un-hide or un-archive an asset. Buying an archived asset again records the trade normally, and the archived flag stays until it is restored.
- `npm run check:asset-lifecycle` is a self-cleaning database regression with 13 checks: accounting and TWR are unchanged after hide, deletes are blocked with prices present, concurrent deletes are handled, and archived bond history is kept.

## 2026-10-27 — Phase 4: valuation UI to the roadmap layout
- **`/valuation` overview:** one glass surface with text metrics (valued, upside > 0, stale prices, values changed by the new formulas), search by stock or method, and sorting by upside / date / name.
  - Each row shows the last stored price date. A stale-price badge uses the Settings price threshold.
  - A badge appears when a value would change under today's formulas.
- **Stock page:** one metric strip instead of four KPI cards, a football field on an opaque well with the price date, and method tabs over the valuation history.
- **Editor:**
  - 5Y | 10Y control in the step bar (residual income with data for that horizon only); it drives the horizon card.
  - Result inspector at ~78% (dim) / 84% (light) opacity with a thin accent edge.
  - Glass blur reduced to 10px under 640px. Solid fallbacks also cover the inspector.
- Screen-reader summaries for the RI waterfall, ROE vs Ke and stage timeline charts.

## 2026-10-27 — Phase 5: missing valuation tests
- `valuation-phase5.test.ts` covers two areas:
  - SOTP with staged FCFF / FCFE and multi-stage RIM segments (debt counted once, errors surfaced).
  - RIM at 2/5/10 years against an independent closed form (perpetuity, persistence, none), plus a hand-worked 2-year example.
- `npm run check:valuation-roundtrip`: database save → read → evaluate and JSON round trip (self-cleaning).
- `e2e/valuation-smoke.mjs`: Playwright smoke at 375/720/768/1440 px in dim and light themes (no horizontal scroll, no console errors, focus visible, staged switch).

## 2026-10-27 — Phase 3: save RIM horizon snapshots
- "บันทึกผล h ปีเป็น valuation แยก" under the 5Y/10Y comparison. It saves the first h forecast years as a new `residual_income` valuation tagged `horizonSnapshot`, with the continuing value re-based at year h. Years are never added.
- Snapshots show in history with a badge but never replace the latest valuation of a method (stock page average/median, overview, data quality).

## 2026-10-27 — Phase 2: configurable date-consistency policy
- Settings → "เกณฑ์วันที่ข้อมูลของ valuation" (inputs / price / statements, defaults 180 / 7 / 548 days), stored in `settings.timestamp_policy` (additive migration 0012) and available at REST `/api/v1/settings/timestamp-policy`.
- Valuation list, editor and data quality now also check the last stored price on or before the valuation date and the latest fiscal year (year-end taken as 31 Dec), not only Rf / ERP / beta dates.
- New data-quality check "วันที่ข้อมูล valuation" for the latest valuation per symbol and method.

## 2026-10-27 — Phase 1 follow-up: RIM scenarios and warnings
- Residual income Bear/Base/Bull (`scenarios`: roeShift, payoutRatio, terminalGrowth, terminalRoe, persistence). It uses the same probability aggregation as DCF (`aggregateScenarios`, extracted from `scenarioAnalysis` with no change in results). Available in the editor, REST and MCP.
- Payout × ω sensitivity grid.
- Warnings: payout outside 0–100%, an EPS override that differs from an entered ROE (implied ROE shown), and first-year ROE more than 5 points from the statements' ROE (`historicalRoe`, check only).
- Scenario panels (DCF and RIM) state the difference between sensitivity, scenario probability and investment conviction.

## 2026-10-27 — Valuation model `2026.10-val6`

### Added
- Staged multi-stage DCF (FCFF / FCFE): `forecastMode: "staged"` with 2–4 stages (1–20 years). Stage-level growth and margin paths, plus optional capex, D&A, NWC, tax and δ. It feeds the same yearly forecast, terminal value, mid-year and bridge code as the legacy fade.
  - Stage editor: mode switch, example 5Y/10Y layouts, timeline chart.
  - Stage-aware scenarios (`stageOverrides`), sensitivity and reverse DCF (`basis: "stage_shift"`).
- Residual income horizons:
  - 5Y vs 10Y comparison on one dataset (`compareHorizons`), with the continuing value recomputed at each horizon and missing years reported, not invented.
  - Waterfall, book-value roll-forward with EPS / stated-BV provenance, ROE vs Ke chart.
  - Sensitivities: ω, Ke × terminal ROE, Ke × g. Exposed via REST and MCP.
- `timestampFlags`: input / price / statement dates that do not match the valuation date.
- Editor step navigation and sticky result inspector. Overview value-range bars with the price marker.

### Changed
- Airy glass theme:
  - Navy `#07111F → #101B31` with cyan / ice / lilac / mint / coral accents; light `#F3F8FF`.
  - Glass panels at ~52–58% alpha with 18–20px blur. Inputs and data grids at 88–94% opacity.
  - AA contrast checked. Reduced transparency, reduced motion, forced colors and no-backdrop-filter fallbacks. Visible focus rings.
- Component classes moved into `@layer components`, so utility classes such as `w-20` on `.input` now apply.
- Overview upside uses the median of the latest value per method, not the mean.
- Older valuations whose value recomputes identically are labelled "same value" and no longer raise a data-quality warning.

### Compatibility
- Assumptions without `forecastMode` behave exactly as before (golden tests at `ac78d85`). No database migration: new fields live in the existing JSON assumptions.
