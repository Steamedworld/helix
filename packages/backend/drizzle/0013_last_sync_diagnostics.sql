ALTER TABLE `nodes` ADD COLUMN `last_sync_mode` text;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_fallback_reason` text;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_items_synced` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_versions_synced` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_files_synced` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_tombstones_applied` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_libraries_removed` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_items_removed` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_versions_removed` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_files_removed` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_diagnostics_updated_at` text;
