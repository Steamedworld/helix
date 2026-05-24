ALTER TABLE `media_items` ADD `parent_id` text REFERENCES `media_items`(`id`);
--> statement-breakpoint
ALTER TABLE `media_items` ADD `season_number` integer;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `episode_number` integer;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `episode_title` text;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `absolute_episode_number` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_items_parent_id_idx` ON `media_items` (`parent_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_items_kind_parent_id_idx` ON `media_items` (`kind`, `parent_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_items_season_episode_idx` ON `media_items` (`season_number`, `episode_number`);
