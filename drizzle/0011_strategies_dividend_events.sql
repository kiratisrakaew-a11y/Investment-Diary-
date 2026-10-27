CREATE TABLE "dividend_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"asset_id" integer,
	"issuer" text,
	"declaration_date" date,
	"ex_date" date,
	"record_date" date,
	"payment_date" date,
	"dividend_per_share" double precision NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"cash_or_stock" text DEFAULT 'cash' NOT NULL,
	"kind" text DEFAULT 'unknown' NOT NULL,
	"fiscal_period" text,
	"source" text NOT NULL,
	"source_event_id" text NOT NULL,
	"retrieved_at" timestamp DEFAULT now() NOT NULL,
	"announced_at" date,
	"data_quality_status" text DEFAULT 'unverified' NOT NULL,
	"split_adjustment_policy" text DEFAULT 'as_reported' NOT NULL,
	"withholding_tax_rate" double precision,
	"withholding_source" text,
	"note" text,
	"revisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "financial_statements" ADD COLUMN "published_at" date;--> statement-breakpoint
ALTER TABLE "dividend_events" ADD CONSTRAINT "dividend_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "div_source_event_uq" ON "dividend_events" USING btree ("source","source_event_id");--> statement-breakpoint
CREATE INDEX "div_symbol_ex_idx" ON "dividend_events" USING btree ("symbol","ex_date");