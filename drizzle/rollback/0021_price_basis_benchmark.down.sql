-- Rollback for 0021_price_basis_benchmark: drops the benchmark registry and the two Settings defaults it added.
-- Prices, benchmark prices and every other setting are untouched. Run manually, then delete the 0021 row from
-- drizzle.__drizzle_migrations if the migration should be re-applied later.
DROP TABLE IF EXISTS "benchmark_meta";
ALTER TABLE "settings" DROP COLUMN IF EXISTS "default_benchmark";
ALTER TABLE "settings" DROP COLUMN IF EXISTS "default_return_basis";
