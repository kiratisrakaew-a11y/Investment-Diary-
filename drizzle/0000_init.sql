CREATE TYPE "public"."asset_class" AS ENUM('thai_stock', 'us_stock', 'bond', 'fund', 'gold', 'cash');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('THB', 'USD');--> statement-breakpoint
CREATE TYPE "public"."note_source" AS ENUM('web', 'claude', 'chatgpt', 'api');--> statement-breakpoint
CREATE TYPE "public"."note_type" AS ENUM('idea', 'thesis', 'review', 'lesson', 'market');--> statement-breakpoint
CREATE TYPE "public"."price_source" AS ENUM('yahoo', 'sec_th', 'manual');--> statement-breakpoint
CREATE TYPE "public"."tx_type" AS ENUM('buy', 'sell', 'dividend', 'coupon', 'deposit', 'withdraw', 'fee');--> statement-breakpoint
CREATE TABLE "allocation_targets" (
	"asset_class" "asset_class" PRIMARY KEY NOT NULL,
	"target_pct" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"asset_class" "asset_class" NOT NULL,
	"currency" "currency" DEFAULT 'THB' NOT NULL,
	"price_source" "price_source" DEFAULT 'manual' NOT NULL,
	"provider_symbol" text,
	"coupon_rate" double precision,
	"maturity_date" date,
	"face_value" double precision,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "assets_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "benchmark_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"date" date NOT NULL,
	"close" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"pair" text DEFAULT 'USDTHB' NOT NULL,
	"date" date NOT NULL,
	"rate" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"type" "note_type" DEFAULT 'idea' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"asset_ids" integer[] DEFAULT '{}' NOT NULL,
	"conviction" integer,
	"source" "note_source" DEFAULT 'web' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"date" date NOT NULL,
	"close" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"risk_free_rate" double precision DEFAULT 2 NOT NULL,
	"benchmark_symbol" text DEFAULT '^SET.BK' NOT NULL,
	"base_currency" "currency" DEFAULT 'THB' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"asset_id" integer,
	"type" "tx_type" NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"price" double precision DEFAULT 0 NOT NULL,
	"fee" double precision DEFAULT 0 NOT NULL,
	"fx_rate" double precision DEFAULT 1 NOT NULL,
	"note_id" integer,
	"memo" text,
	"source" "note_source" DEFAULT 'web' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bench_symbol_date_uq" ON "benchmark_prices" USING btree ("symbol","date");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_pair_date_uq" ON "fx_rates" USING btree ("pair","date");--> statement-breakpoint
CREATE INDEX "notes_date_idx" ON "notes" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "prices_asset_date_uq" ON "prices" USING btree ("asset_id","date");--> statement-breakpoint
CREATE INDEX "tx_date_idx" ON "transactions" USING btree ("date");