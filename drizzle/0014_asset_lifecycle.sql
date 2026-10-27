CREATE TABLE "asset_lifecycle_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"source" text DEFAULT 'web' NOT NULL,
	"detail" jsonb,
	"at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "hidden_in_holdings_at" timestamp;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
CREATE INDEX "asset_lifecycle_asset_idx" ON "asset_lifecycle_events" USING btree ("asset_id");