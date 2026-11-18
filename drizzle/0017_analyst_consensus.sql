CREATE TABLE "analyst_consensus" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"as_of" date NOT NULL,
	"source" text NOT NULL,
	"source_note" text,
	"currency" text,
	"target_mean" numeric,
	"target_median" numeric,
	"target_high" numeric,
	"target_low" numeric,
	"analysts" integer,
	"recommendation_key" text,
	"recommendation_mean" numeric,
	"price_at_fetch" numeric,
	"yahoo_symbol" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "analyst_consensus_source_ck" CHECK ("analyst_consensus"."source" in ('yahoo','manual','mcp')),
	CONSTRAINT "analyst_consensus_has_target_ck" CHECK ("analyst_consensus"."target_mean" is not null or "analyst_consensus"."target_median" is not null),
	CONSTRAINT "analyst_consensus_positive_ck" CHECK (coalesce("analyst_consensus"."target_mean", 1) > 0 and coalesce("analyst_consensus"."target_median", 1) > 0 and coalesce("analyst_consensus"."target_high", 1) > 0 and coalesce("analyst_consensus"."target_low", 1) > 0),
	CONSTRAINT "analyst_consensus_range_ck" CHECK ("analyst_consensus"."target_low" is null or "analyst_consensus"."target_high" is null or "analyst_consensus"."target_low" <= "analyst_consensus"."target_high"),
	CONSTRAINT "analyst_consensus_analysts_ck" CHECK ("analyst_consensus"."analysts" is null or "analyst_consensus"."analysts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "analyst_consensus_symbol_source_asof_uq" ON "analyst_consensus" USING btree ("symbol","source","as_of");--> statement-breakpoint
CREATE INDEX "analyst_consensus_symbol_idx" ON "analyst_consensus" USING btree ("symbol");