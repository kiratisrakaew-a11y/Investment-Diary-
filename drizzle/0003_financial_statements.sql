CREATE TABLE "financial_statements" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"asset_id" integer,
	"fiscal_year" integer NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"data" jsonb NOT NULL,
	"source_file" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statement_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"status" text NOT NULL,
	"years_found" integer[] DEFAULT '{}' NOT NULL,
	"unit_detected" text,
	"notes" text DEFAULT '' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "financial_statements" ADD CONSTRAINT "financial_statements_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fin_symbol_year_uq" ON "financial_statements" USING btree ("symbol","fiscal_year");