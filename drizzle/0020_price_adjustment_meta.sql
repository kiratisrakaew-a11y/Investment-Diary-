CREATE TABLE "price_adjustment_meta" (
	"asset_id" integer PRIMARY KEY NOT NULL,
	"adj_base_date" date NOT NULL,
	"adj_last_event_date" date,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_adjustment_meta" ADD CONSTRAINT "price_adjustment_meta_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;