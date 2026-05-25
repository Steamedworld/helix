CREATE TABLE `library_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`can_view` integer NOT NULL DEFAULT true,
	`can_play` integer NOT NULL DEFAULT true,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lib_perms_unique` ON `library_permissions` (`library_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_lib_perms_user` ON `library_permissions` (`user_id`);
