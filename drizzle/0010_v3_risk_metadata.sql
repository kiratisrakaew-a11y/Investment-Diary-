ALTER TABLE "assets" ADD COLUMN "issuer" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "sector" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "sector_source" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "sector_as_of" date;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "credit" jsonb;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "yield_curve" jsonb;