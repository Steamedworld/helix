CREATE TABLE `enrichment_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`media_item_id` text NOT NULL REFERENCES `media_items`(`id`) ON DELETE CASCADE,
	`status` text NOT NULL DEFAULT 'pending',
	`attempts` integer NOT NULL DEFAULT 0,
	`max_attempts` integer NOT NULL DEFAULT 3,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_enrichment_jobs_status` ON `enrichment_jobs` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_enrichment_jobs_media_item` ON `enrichment_jobs` (`media_item_id`);
