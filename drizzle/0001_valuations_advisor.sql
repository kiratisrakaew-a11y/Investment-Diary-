CREATE TYPE "public"."valuation_method" AS ENUM('dcf_fcff', 'dcf_fcfe', 'ddm', 'residual_income', 'multiples', 'bond');--> statement-breakpoint
CREATE TABLE "advisor_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "valuations" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer,
	"symbol" text NOT NULL,
	"date" date NOT NULL,
	"method" "valuation_method" NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"assumptions" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"intrinsic_value" double precision,
	"price_at_valuation" double precision,
	"note" text DEFAULT '' NOT NULL,
	"source" "note_source" DEFAULT 'web' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "valuations_symbol_idx" ON "valuations" USING btree ("symbol");