# PR 5 — Assumption Governance, Provenance & End-to-End Validation (Phase F, P1/P2)

Spec: `INVESTMENT_DIARY_FINANCIAL_MODEL_REMEDIATION.md` §7 and §9 (PR 5) · Branch: `claude/vigilant-fermi-tf3wq7` · Baseline: PR 4 (`4be5d91`)

## 1. Summary

| Area | Before | After |
|---|---|---|
| Rf / ERP provenance | Only a number in Settings (default 2% / 6%), shown everywhere as if it were market data | Settings store the source, series and as-of date. Unsourced values are tagged "ค่าตัวอย่าง" (illustrative) in Settings, on the dashboard, in the valuation result and in the data-quality report |
| Valuation inputs | `inputMeta` (PR 2) had to be typed by hand | New valuations copy Rf/ERP sources from Settings, and beta's source (observations, benchmark, β). A "Key drivers" box next to the result shows each input with its source or an illustrative warning |
| Model versioning | Saved valuations stored only value/price/upside | Each save stores `modelVersion`, `savedAt` and the warnings shown at save time. The stock page labels older valuations "สูตรเวอร์ชันก่อน" and shows the version for each row |
| Percent vs decimal | No guard (API/MCP could send 2.5 meaning 2.5% → 250%) | `rateScaleWarnings` flags implausible decimals (e.g. Rf > 25%, terminal g > 20%) in every valuation explanation. UI percent fields warn when a value looks like a decimal typed into a % field |
| Warnings placement | DDM/RI/multiples warnings appeared only inside the calculation detail | Shown next to the result for every method |
| Import / export | — | Valuations export to JSON (`investment-diary/valuation` v1, with the model version and sources) and import back. Older files get defaults for newer fields; malformed files are rejected with the field and reason |
| Data-quality panel | Portfolio issues only (PR 1) | `/data-quality` page, `GET /api/v1/data-quality`, MCP `get_data_quality` and an advisor tool. Checks: prices, FX, market-input provenance, cash/NAV, ledger, benchmark type and freshness, valuation formula versions, bond conventions. Each check links to where it is fixed |
| Bond conventions in the portfolio | Holdings analytics always assumed semi-annual ACT/ACT | Assets store `couponFrequency` and `dayCount` (add-asset form plus a bond-terms form on the asset page). Holdings analytics use them and list any assumed defaults per bond |
| Asset updates | `updateAsset` parsed with schema defaults, so a partial update would reset currency to THB and price source to manual (latent: no caller until now) | Only the supplied fields are written |
| Documentation | Formulas spread across code comments | `docs/MODEL_DOCUMENTATION.md`: every model, convention, default, limit and validation rule. Settings shows the model version and links to the data-quality report |
| End-to-end validation | Unit tests per module | `src/lib/e2e.test.ts` runs one synthetic portfolio through ledger → value series → metrics → optimizer → DCF → bonds → governance. Each step is checked against invariants (NAV identity, Σweights, XIRR NPV = 0, bound feasibility, equity bridge, 92.5613 bond reference) |

## 2. Changed files

- New: `src/lib/governance.ts`, `src/lib/rate-scale.ts`, `src/server/services/data-quality.ts`, `src/app/(app)/data-quality/page.tsx`, `src/app/api/v1/data-quality/route.ts`, `docs/MODEL_DOCUMENTATION.md`, `drizzle/0005_pr5_provenance.sql`.
- Schema/validation: `src/db/schema.ts` (settings `rf_source`, `rf_series`, `rf_as_of`, `erp_source`, `erp_as_of`; assets `coupon_frequency`, `day_count`), `src/lib/validation.ts`, `src/server/services/settings.ts`, `src/server/services/assets.ts` (partial-update fix).
- Valuation: `src/server/services/valuations.ts` (model version and audit fields), `src/server/services/valuation-defaults.ts`, `src/components/ValuationEditor.tsx` (provenance defaults, key drivers, warnings, export/import), `src/components/SavedValuationList.tsx`, `src/app/(app)/valuation/stock/[symbol]/page.tsx`, `src/lib/valuation-explain.ts` (scale warnings), `src/components/fields.tsx` (% guard).
- Bonds: `src/lib/finance/bonds.ts` (`specFromBondAsset`), `src/server/services/bonds.ts`, `src/app/(app)/bonds/page.tsx`, `src/components/AssetForms.tsx`, `src/app/(app)/holdings/[id]/page.tsx`, `src/app/(app)/actions.ts`.
- Surfaces: `src/server/mcp.ts`, `src/server/advisor.ts`, `src/server/openapi.ts`, `src/app/(app)/settings/page.tsx`, `src/app/(app)/page.tsx`, `src/components/DataQuality.tsx`.
- Tests: `src/lib/governance.test.ts` (10), `src/lib/e2e.test.ts` (7).

## 3. Migration impact

`drizzle/0005_pr5_provenance.sql` adds seven nullable columns (`ALTER TABLE … ADD COLUMN` only). No data is updated.

- Existing installs have no Rf/ERP source, so these show as illustrative until a source is entered in Settings.
- Existing valuations have no `modelVersion`. They show as "older formula version" and their stored values are not changed.
- Existing bonds show their assumed conventions until frequency and day count are set on the asset page.
- On Vercel, `vercel-build` runs the migration automatically before the build.

## 4. Verification (actual results)

| Command / check | Result |
|---|---|
| `npx vitest run src/lib/governance.test.ts` against a stub with the PR 4 code | 10 failed / 0 passed (10). The module did not exist |
| `npm test` | 12 files, **169 passed** |
| `npm run lint` | No ESLint warnings or errors |
| `npx tsc --noEmit` | 0 errors |
| `npm run build` | success (`/data-quality`, `/api/v1/data-quality` built) |
| `npm run db:migrate` (local) | applied |
| REST `GET /api/v1/data-quality` on fresh data | status `warnings`: illustrative Rf/ERP, price-index benchmark, 3 valuations from an older version, bond without conventions |
| MCP `get_data_quality` | returns the same report |
| Browser flow | Set Rf/ERP sources in Settings → saved. Set LB29DA to 2×/yr, ACT/365F → saved, with currency and price source unchanged. New PTT valuation shows the key drivers with sources. Save stored `modelVersion = 2026.10-pr5` and the full `inputMeta`. Data-quality page then showed only the benchmark and old-valuation warnings. No console errors. The test valuation was removed afterwards |

## 5. Open issues

- No live market-data feed for Rf/ERP: values and sources are entered by hand. A ThaiBMA/BOT yield feed could fill both.
- The per-asset expected-return overrides in the optimizer do not yet store source, date or uncertainty.
- Bond valuations (calculator) are not saved or exported as files; only equity valuations are.
- Holiday calendars, a total-return SET index (SET TRI) data source and corporate actions (splits/rights) remain outside the remediation scope.
