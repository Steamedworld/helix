-- Node-level progress sync settings
ALTER TABLE `nodes` ADD COLUMN `progress_sync_enabled` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `allow_progress_push` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `allow_progress_receive` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Remote progress records (source-side: progress pushed from a viewer Home)
CREATE TABLE IF NOT EXISTS `remote_watch_progress` (
  `id` text PRIMARY KEY,
  `source_node_id` text NOT NULL REFERENCES `nodes`(`id`) ON DELETE CASCADE,
  `remote_viewer_hash` text NOT NULL,
  `media_item_id` text NOT NULL REFERENCES `media_items`(`id`) ON DELETE CASCADE,
  `position_seconds` real NOT NULL DEFAULT 0,
  `duration_seconds` real,
  `watched` integer NOT NULL DEFAULT 0,
  `updated_at` text NOT NULL,
  `client_event_id` text,
  `created_at` text NOT NULL,
  UNIQUE(`source_node_id`, `remote_viewer_hash`, `media_item_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_remote_progress_node` ON `remote_watch_progress`(`source_node_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_remote_progress_media` ON `remote_watch_progress`(`media_item_id`, `source_node_id`);
--> statement-breakpoint
-- Viewer-side push sync status on watch_states
ALTER TABLE `watch_states` ADD COLUMN `progress_push_status` text;
--> statement-breakpoint
ALTER TABLE `watch_states` ADD COLUMN `progress_push_at` text;
--> statement-breakpoint
ALTER TABLE `watch_states` ADD COLUMN `progress_push_error_code` text;
