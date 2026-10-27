# Changelog

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
