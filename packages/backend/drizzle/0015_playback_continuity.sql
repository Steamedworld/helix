ALTER TABLE `nodes` ADD COLUMN `last_playback_issue_at` text;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_playback_issue_mode` text;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_playback_issue_code` text;
--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_playback_issue_message` text;
