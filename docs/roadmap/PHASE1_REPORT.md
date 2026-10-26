# Roadmap v2.0 — Phase 1 Report: Historical Market Data

Branch `claude/vigilant-fermi-tf3wq7` · Phase 0 analysis `f587841`

## Requirements

| Requirement | Result |
|---|---|
| `sync_historical_prices` with symbols, startDate, endDate, lookbackDays, priceType, overwriteExisting, dryRun | Done. Also on the advisor, `POST /api/v1/prices/sync` (OpenAPI `syncHistoricalPrices`) and a form on the holdings page. Extra options: `includeBenchmark` and `includeFx` (both default true) |
| Defaults: 365 days, Yahoo, overwrite false, dry run false | Done |
| Reuse Yahoo fetcher and price database | Done. Extended `yahoo.ts` with `fetchDailyHistory` (range, adjclose, split/dividend events); `fetchDailyCloses` kept. Writes go to the existing `prices` / `benchmark_prices` / `fx_rates` tables |
| `updateAllPrices()` uses the shared sync service | Done. Same incremental windows and result shape (`{symbol, ok, rows, error}`); callers unchanged |
| Backfill, incremental, date range | Done |
| Duplicate prevention, idempotent upsert | Already guaranteed by the unique indexes. Writes are now batched with on-conflict do nothing / update; a second run inserts 0 rows (verified on Postgres) |
| Retry, rate limit, partial success | 3 attempts with exponential backoff (0.5 s, 1 s), 300 ms between symbols, per-symbol status (`ok`, `no_data`, `unknown_asset`, `unsupported`, `error`) |
| Data coverage validation | Per series: observations, first/last date, largest gap, staleness. Optimizer eligibility uses the existing `loadUniverse`: whole universe, filtered to the requested symbols, with reasons |
| Raw vs split-adjusted vs dividend-adjusted / total return | `close` keeps its meaning: Yahoo split-adjusted close, now documented. New nullable `adj_close` holds the split + dividend adjusted series, written only for `priceType: adjusted_close`. A separate raw (unadjusted) close is not available from this provider; reported as a limitation, not synthesized |
| Corporate actions | Splits and dividends in the range are returned and warned about. Held assets get an explicit warning that quantities are not adjusted. A split transaction type is deferred (Phase 0 FIX item) |
| Unsupported data reported, not synthesized | Manual assets → `unsupported`. Fund NAV ranges over 400 days → `unsupported`. No adjusted series for funds and gold → warning |
| Post-sync checks: price coverage, common dates, min observations, optimizer eligibility, FX, benchmark | Done through `loadUniverse` reasons (≥ 60 observations, common dates, USDTHB coverage). FX and benchmark are synced and reported in the same call |
| Unknown symbols | Reported with instructions (`add_asset`, providerSymbol `SYMBOL.BK`). Never created (user decision) |
| Data quality | New "ประวัติราคา" check: held assets with fewer than 60 prices in 365 days |

## Files

- New: `src/lib/finance/price-coverage.ts` (range, write planning, coverage, corporate-action warnings, retry), `src/server/services/price-sync.ts` (service + DB deps + zod input), `src/app/api/v1/prices/sync/route.ts`, `drizzle/0006_phase1_adj_close.sql`, tests `src/lib/finance/price-coverage.test.ts` (14), `src/server/services/price-sync.test.ts` (9).
- Modified: `src/lib/prices/yahoo.ts`, `src/server/services/price-updater.ts`, `src/db/schema.ts`, `src/server/mcp.ts`, `src/server/advisor.ts`, `src/server/openapi.ts`, `src/server/api.ts`, `src/lib/governance.ts`, `src/server/services/data-quality.ts`, `src/app/(app)/actions.ts`, `src/app/(app)/holdings/page.tsx`, `docs/MODEL_DOCUMENTATION.md`, tests `src/server/mcp.test.ts`, `src/lib/governance.test.ts`.

Existing functions reused: `getAssetBySymbol`, `loadFxHistory`, `asOf`, `thaiGoldPrice`, `fetchFundNav`, `loadUniverse`, `getPortfolioSummary`, `getSettings`, `assessDataQuality`.

## Database

Migration 0006 adds a nullable `adj_close` column to `prices` and to `benchmark_prices`. No existing rows change, and transactions are untouched. Vercel applies it during build (`vercel-build`).

## MCP tools

Added `sync_historical_prices` (25 tools in total, including `get_server_info`). No existing tool changed its contract.

## Tests

| Run | Result |
|---|---|
| New tests on the Phase 0 code | both files fail to load (modules missing): 23 tests not passing |
| `npm test` | 16 files, **207 passed** |
| `npm run lint` / `npx tsc --noEmit` / `npm run build` | clean / 0 errors / success |
| `npm run db:migrate` (local Postgres) | applied |
| Real DB write path with a deterministic stand-in provider | Dry run wrote nothing. First run inserted 130 prices with `adj_close`, 130 USDTHB and 130 benchmark rows. Second run inserted 0 (130 kept). 0 duplicate rows. KBANK → `unknown_asset`, LB29DA → `unsupported`, CPALL eligible. Test rows deleted afterwards |
| Live server | `/api/v1/version` lists `sync_historical_prices`. REST with an inverted range → 400 `INVALID_RANGE`. The MCP call returns per-symbol results; the provider fails here with `fetch failed` because this sandbox has no internet, after retries, and the other symbols still complete |

## Known issues / not done

- **Live Yahoo fetch for KBANK/BBL/AP/PLANB not verified here** (no outbound internet in the build sandbox). Locally these symbols are not assets, so they are reported as unknown. After deploy: `add_asset` each (providerSymbol `KBANK.BK`, `BBL.BK`, `AP.BK`, `PLANB.BK`), then `sync_historical_prices` with `lookbackDays: 365`.
- Split transaction type and holdings adjustment: deferred (Phase 0 FIX item); currently warned only.
- Fund NAV backfill is limited to 400 days per call (one API request per day).
- Large batches: Vercel functions stop at 60 s, so for long ranges with many symbols split them into several calls (about 20 symbols per call is comfortable).

## Deployment

Pushed to `claude/vigilant-fermi-tf3wq7` (production branch). After Vercel shows **Ready**, `/api/v1/version` should list `sync_historical_prices`; refresh the ChatGPT/Claude connector to see the new tool.
