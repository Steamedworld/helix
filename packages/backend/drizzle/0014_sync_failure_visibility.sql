ALTER TABLE `nodes` ADD COLUMN `last_sync_attempt_at` text;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_error_at` text;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_error_code` text;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_error_message` text;
