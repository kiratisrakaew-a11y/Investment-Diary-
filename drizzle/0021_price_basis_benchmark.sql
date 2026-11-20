CREATE TABLE "benchmark_meta" (
	"symbol" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"source" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "default_return_basis" text DEFAULT 'price_return' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "default_benchmark" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
-- Seed the registry (inserts only; never overwrites): Settings' benchmark with its kind, SETTRI as total return,
-- every other stored index as a price index.
INSERT INTO "benchmark_meta" ("symbol", "kind", "source")
  SELECT "benchmark_symbol", "benchmark_kind", 'settings' FROM "settings" WHERE "id" = 1
  ON CONFLICT ("symbol") DO NOTHING;--> statement-breakpoint
INSERT INTO "benchmark_meta" ("symbol", "kind", "label", "source")
  VALUES ('SETTRI', 'total_return', 'SET Total Return Index', 'seed')
  ON CONFLICT ("symbol") DO NOTHING;--> statement-breakpoint
INSERT INTO "benchmark_meta" ("symbol", "kind", "source")
  SELECT DISTINCT "symbol", 'price_index', 'seed' FROM "benchmark_prices"
  ON CONFLICT ("symbol") DO NOTHING;
