ALTER TABLE `media_items` ADD `overview` text;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `poster_path` text;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `backdrop_path` text;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `original_title` text;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `release_date` text;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `content_rating` text;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `runtime_seconds` integer;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `metadata_status` text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE `media_items` ADD `metadata_source` text;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `metadata_updated_at` integer;
--> statement-breakpoint
ALTER TABLE `media_files` ADD `missing_at` integer;
