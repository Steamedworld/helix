CREATE TABLE IF NOT EXISTS `catalog_tombstones` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL REFERENCES `nodes`(`id`) ON DELETE CASCADE,
	`entity_type` text NOT NULL CHECK(`entity_type` IN ('library','media_item','media_version','media_file')),
	`entity_id` text NOT NULL,
	`deleted_at` text NOT NULL,
	`reason` text CHECK(`reason` IN ('scan_missing','integration_delete','admin_disconnect','unknown')),
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tombstones_node_deleted` ON `catalog_tombstones` (`node_id`,`deleted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tombstones_entity` ON `catalog_tombstones` (`entity_type`,`entity_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tombstones_deleted_at` ON `catalog_tombstones` (`deleted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_media_versions_updated_at` ON `media_versions` (`updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_media_files_updated_at` ON `media_files` (`updated_at`);
