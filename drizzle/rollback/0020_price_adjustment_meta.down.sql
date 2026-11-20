-- Rollback for 0020_price_adjustment_meta: drops only the metadata table 0020 created
-- (adj_close values in prices are not touched). Run manually, then delete the 0020 row from
-- drizzle.__drizzle_migrations if the migration should be re-applied later.
DROP TABLE IF EXISTS "price_adjustment_meta";
