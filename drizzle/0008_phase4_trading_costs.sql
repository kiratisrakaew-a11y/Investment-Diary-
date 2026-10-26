ALTER TABLE "assets" ADD COLUMN "lot_size" double precision;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "trading_costs" jsonb DEFAULT '{}'::jsonb NOT NULL;