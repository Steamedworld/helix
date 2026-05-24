CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_encrypted` text NOT NULL,
	`enabled` integer NOT NULL DEFAULT 1,
	`status` text NOT NULL DEFAULT 'unknown',
	`last_checked_at` integer,
	`last_synced_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `external_media_links` (
	`id` text PRIMARY KEY NOT NULL,
	`media_item_id` text NOT NULL REFERENCES `media_items`(`id`) ON DELETE CASCADE,
	`integration_id` text NOT NULL REFERENCES `integrations`(`id`) ON DELETE CASCADE,
	`external_kind` text NOT NULL,
	`external_id` text NOT NULL,
	`external_guid` text,
	`external_title` text,
	`monitored` integer,
	`quality_profile` text,
	`root_path` text,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_integrations_kind` ON `integrations` (`kind`);
--> statement-breakpoint
CREATE INDEX `idx_integrations_enabled` ON `integrations` (`enabled`);
--> statement-breakpoint
CREATE INDEX `idx_external_links_media_item` ON `external_media_links` (`media_item_id`);
--> statement-breakpoint
CREATE INDEX `idx_external_links_integration` ON `external_media_links` (`integration_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_links_unique` ON `external_media_links` (`integration_id`, `external_kind`, `external_id`);
