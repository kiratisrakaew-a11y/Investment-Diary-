# Changelog

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
