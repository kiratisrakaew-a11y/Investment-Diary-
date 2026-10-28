CREATE TABLE "asset_metric_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"description" text,
	"frequency" text DEFAULT 'irregular' NOT NULL,
	"decimals" integer DEFAULT 2 NOT NULL,
	"chart_color" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"source_default" text,
	"show_in_chart" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "asset_metric_def_frequency_ck" CHECK ("asset_metric_definitions"."frequency" in ('daily','monthly','quarterly','annual','irregular')),
	CONSTRAINT "asset_metric_def_decimals_ck" CHECK ("asset_metric_definitions"."decimals" between 0 and 8)
);
--> statement-breakpoint
CREATE TABLE "asset_metric_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"object_type" text NOT NULL,
	"object_id" integer NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"source" text DEFAULT 'web' NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_metric_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"metric_id" integer NOT NULL,
	"observed_on" date NOT NULL,
	"value" numeric NOT NULL,
	"source" text,
	"note" text,
	"published_on" date,
	"source_kind" text DEFAULT 'manual' NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_metric_threshold_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"metric_id" integer NOT NULL,
	"rule_type" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"green_bound" numeric,
	"yellow_bound" numeric,
	"green_min" numeric,
	"green_max" numeric,
	"yellow_min" numeric,
	"yellow_max" numeric,
	"reason" text,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "asset_metric_thr_rule_ck" CHECK ("asset_metric_threshold_versions"."rule_type" in ('lower_is_better','higher_is_better','target_range')),
	CONSTRAINT "asset_metric_thr_range_ck" CHECK ("asset_metric_threshold_versions"."effective_to" is null or "asset_metric_threshold_versions"."effective_to" > "asset_metric_threshold_versions"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "asset_metric_definitions" ADD CONSTRAINT "asset_metric_definitions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_metric_observations" ADD CONSTRAINT "asset_metric_observations_metric_id_asset_metric_definitions_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."asset_metric_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_metric_threshold_versions" ADD CONSTRAINT "asset_metric_threshold_versions_metric_id_asset_metric_definitions_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."asset_metric_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_metric_def_asset_key_uq" ON "asset_metric_definitions" USING btree ("asset_id","key");--> statement-breakpoint
CREATE INDEX "asset_metric_def_asset_active_idx" ON "asset_metric_definitions" USING btree ("asset_id","is_active","display_order");--> statement-breakpoint
CREATE INDEX "asset_metric_events_asset_idx" ON "asset_metric_events" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_metric_obs_metric_date_uq" ON "asset_metric_observations" USING btree ("metric_id","observed_on");--> statement-breakpoint
CREATE INDEX "asset_metric_obs_metric_date_idx" ON "asset_metric_observations" USING btree ("metric_id","observed_on" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "asset_metric_thr_metric_from_uq" ON "asset_metric_threshold_versions" USING btree ("metric_id","effective_from");