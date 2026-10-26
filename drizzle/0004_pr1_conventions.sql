ALTER TABLE "settings" ADD COLUMN "cash_flow_policy" text DEFAULT 'strict' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "twr_flow_timing" text DEFAULT 'start_of_day' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "benchmark_kind" text DEFAULT 'price_index' NOT NULL;