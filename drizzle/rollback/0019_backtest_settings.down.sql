-- Rollback for 0019_backtest_settings: removes only the column 0019 added (no other data touched).
-- Run manually (psql "$DATABASE_URL" -f drizzle/rollback/0019_backtest_settings.down.sql), then delete the
-- 0019 row from drizzle.__drizzle_migrations if the migration should be re-applied later.
ALTER TABLE "settings" DROP COLUMN IF EXISTS "dividend_payment_lag_days";
