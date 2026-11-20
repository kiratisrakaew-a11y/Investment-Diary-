-- Rollback for 0022_mu_cap: drops the μ cap setting only (every other setting is untouched). Run manually,
-- then delete the 0022 row from drizzle.__drizzle_migrations if the migration should be re-applied later.
ALTER TABLE "settings" DROP COLUMN IF EXISTS "mu_cap_pct";
