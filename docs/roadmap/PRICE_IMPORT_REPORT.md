# Bulk price import — report

Request: upload many prices manually at once.

## What was added (extends Phase 1, no new tables)
- Parser `src/lib/prices/price-import.ts`: long, wide and one-symbol formats; Thai/English headers; ISO, day-first, Buddhist-era, Excel-serial and month-name dates; errors with line numbers.
- Service `importPrices` in `src/server/services/price-sync.ts`: groups by symbol, reports unknown symbols (not created), skips future dates, last row wins for duplicate dates, then writes through the shared `planWrites` / batched write path (idempotent, keeps stored prices unless `overwriteExisting`, `dryRun`). Limit 50,000 rows.
- `src/lib/spreadsheet.ts`: the exceljs worksheet → CSV helper, now shared with statement uploads.
- Surfaces: MCP and advisor tool `import_prices`; `POST /api/v1/prices/import` (multipart .csv/.xlsx ≤ 4.4 MB, or JSON `rows` / `csv`); `GET /api/v1/prices/import/template`; OpenAPI op `importPrices`; holdings page section "นำเข้าราคาจากไฟล์" (preview first, then save).

## Verification
- Tests: 10 new (parser 7, service 3) plus the MCP contract; 217 in total pass. tsc, lint and build are clean.
- Local Postgres, wide CSV (2 assets + 1 unknown × 60 days, Buddhist-era day-first dates): dry run planned 120 and wrote nothing → the real run inserted 120 → a rerun inserted 0 and kept 120; no duplicate dates; the unknown symbol was reported.
- One-symbol Yahoo-style CSV through the browser: preview → save inserted 2 rows with adj close; the bad line was reported as line 4.
- .xlsx with Thai headers and date cells: parsed as long format. MCP `import_prices` dry run returned per-symbol results. A .pdf upload returned 415.
- Test rows were deleted afterwards.
