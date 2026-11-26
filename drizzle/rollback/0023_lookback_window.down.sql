-- Rollback for 0023_lookback_window: drops the three window defaults only (every other setting is untouched).
-- Run manually, then delete the 0023 row from drizzle.__drizzle_migrations if it should be re-applied later.
ALTER TABLE "settings" DROP COLUMN IF EXISTS "min_obs_per_asset";
ALTER TABLE "settings" DROP COLUMN IF EXISTS "default_history_policy";
ALTER TABLE "settings" DROP COLUMN IF EXISTS "default_window_preset";
