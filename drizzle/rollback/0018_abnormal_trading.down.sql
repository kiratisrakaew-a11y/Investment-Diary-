-- Rollback for drizzle/0018_abnormal_trading.sql (run manually, only if needed).
-- Removes ONLY what 0018 added: the two new tables and prices.volume. Prices (close / adj_close) are untouched.
-- Afterwards delete the 0018 row from drizzle.__drizzle_migrations so the migration can be re-applied later.
BEGIN;
DROP TABLE IF EXISTS "stock_events";
DROP TABLE IF EXISTS "shares_outstanding";
ALTER TABLE "prices" DROP COLUMN IF EXISTS "volume";
COMMIT;
