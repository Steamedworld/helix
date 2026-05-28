CREATE TABLE `trusted_home_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`label` text,
	`expires_at` integer,
	`used_at` integer,
	`revoked_at` integer,
	`created_by_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_invites_token_hash` ON `trusted_home_invites` (`token_hash`);
