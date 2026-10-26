ALTER TABLE "assets" ADD COLUMN "coupon_frequency" integer;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "day_count" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "rf_source" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "rf_series" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "rf_as_of" date;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "erp_source" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "erp_as_of" date;