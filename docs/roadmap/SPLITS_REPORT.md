# Stock splits (แตกพาร์ / รวมพาร์): report

Problem: the ledger had no split. After a 1:2 split the quantity stayed at the old number while prices (Yahoo, split-adjusted) halved, so the position showed half its value. Stored price history also had a fake −50% day, which distorted returns, β, the optimizer, the backtest and the stress test.

## Changes
- `split` transaction type (migration 0009, additive). The ledger multiplies units, keeps the total cost, moves no cash and books no P&L.
- `planSplitPriceRepair` + `adjustPricesForSplit`: a guarded, idempotent repair of stored prices before the ex-date.
- `recordSplit` (dry run → save): validates holdings, rejects duplicates, records the split and repairs prices.
  - Surfaces: transactions page form, MCP/advisor `record_split`, REST `POST /api/v1/transactions/split`, OpenAPI.
  - `record_transaction` also accepts `type: "split"` (splitFrom/splitTo), without the price repair.
- Data quality: a new "แตกพาร์" check (`detectUnrecordedSplits`). The Yahoo split warning now names the fix.

## Verification
- 8 new tests:
  - Ledger: 1:2 and 10:1, sell after a split, rejection with no holding, no cash flow, value continuity.
  - Repair: unadjusted / already adjusted / ambiguous / no data, idempotence.
  - Detection.
- All 278 tests pass; tsc, lint and build are clean.
- Local DB, simulated 1:2 PTT split from 2026-10-22 (prices halved from that date):
  - Before: value 45,255 THB (half) and the data-quality check flagged PTT 2026-10-22 ≈1:2.
  - Dry run: 517 rows to adjust, nothing written.
  - Saved from the web form: 6,000 shares, value 90,510 THB, average 34.46 → 17.23, cost basis unchanged, prices continuous; the check cleared.
  - MCP duplicate rejected. A 10:1 reverse split on correctly adjusted CPALL data was reported as already adjusted.
- Test data restored afterwards (17 transactions; original PTT prices).
