# Changelog

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
