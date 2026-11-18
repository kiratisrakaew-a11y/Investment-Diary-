CREATE TABLE "shares_outstanding" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"effective_date" date NOT NULL,
	"shares" double precision NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shares_outstanding_positive_ck" CHECK ("shares_outstanding"."shares" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"event_date" date NOT NULL,
	"event_type" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stock_events_type_ck" CHECK ("stock_events"."event_type" in ('earnings','ma','xd','news','other'))
);
--> statement-breakpoint
ALTER TABLE "prices" ADD COLUMN "volume" double precision;--> statement-breakpoint
CREATE UNIQUE INDEX "shares_outstanding_symbol_date_uq" ON "shares_outstanding" USING btree ("symbol","effective_date");--> statement-breakpoint
CREATE INDEX "stock_events_symbol_date_idx" ON "stock_events" USING btree ("symbol","event_date");