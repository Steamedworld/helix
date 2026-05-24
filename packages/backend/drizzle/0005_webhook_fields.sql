ALTER TABLE `integrations` ADD `webhook_enabled` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `integrations` ADD `webhook_secret_hash` text;
--> statement-breakpoint
ALTER TABLE `integrations` ADD `last_webhook_at` integer;
--> statement-breakpoint
ALTER TABLE `integrations` ADD `last_webhook_event` text;
--> statement-breakpoint
ALTER TABLE `integrations` ADD `last_webhook_error` text;
