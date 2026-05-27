ALTER TABLE `nodes` ADD COLUMN `api_token_encrypted` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `federation_token_hash` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_sync_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD COLUMN `last_error` text;
