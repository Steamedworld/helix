CREATE TABLE IF NOT EXISTS `nodes` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `kind` text DEFAULT 'local' NOT NULL,
  `base_url` text,
  `status` text DEFAULT 'unknown' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
  `id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `role` text DEFAULT 'user' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `libraries` (
  `id` text PRIMARY KEY NOT NULL,
  `node_id` text NOT NULL REFERENCES `nodes`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `kind` text DEFAULT 'movies' NOT NULL,
  `root_path` text NOT NULL,
  `scan_status` text DEFAULT 'idle' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `media_items` (
  `id` text PRIMARY KEY NOT NULL,
  `library_id` text NOT NULL REFERENCES `libraries`(`id`) ON DELETE CASCADE,
  `kind` text DEFAULT 'movie' NOT NULL,
  `title` text NOT NULL,
  `sort_title` text,
  `year` integer,
  `external_tmdb_id` text,
  `external_tvdb_id` text,
  `external_musicbrainz_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `media_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `media_item_id` text NOT NULL REFERENCES `media_items`(`id`) ON DELETE CASCADE,
  `label` text,
  `quality_label` text,
  `resolution_width` integer,
  `resolution_height` integer,
  `video_codec` text,
  `audio_codec` text,
  `container` text,
  `duration_seconds` real,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `media_files` (
  `id` text PRIMARY KEY NOT NULL,
  `node_id` text NOT NULL REFERENCES `nodes`(`id`) ON DELETE CASCADE,
  `library_id` text NOT NULL REFERENCES `libraries`(`id`) ON DELETE CASCADE,
  `media_item_id` text NOT NULL REFERENCES `media_items`(`id`) ON DELETE CASCADE,
  `media_version_id` text NOT NULL REFERENCES `media_versions`(`id`) ON DELETE CASCADE,
  `path` text NOT NULL UNIQUE,
  `filename` text NOT NULL,
  `extension` text NOT NULL,
  `size_bytes` integer,
  `file_hash` text,
  `discovered_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `watch_states` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `media_item_id` text NOT NULL REFERENCES `media_items`(`id`) ON DELETE CASCADE,
  `position_seconds` real DEFAULT 0 NOT NULL,
  `duration_seconds` real,
  `completed` integer DEFAULT false NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `playback_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `node_id` text NOT NULL REFERENCES `nodes`(`id`) ON DELETE CASCADE,
  `media_item_id` text NOT NULL REFERENCES `media_items`(`id`) ON DELETE CASCADE,
  `media_version_id` text NOT NULL REFERENCES `media_versions`(`id`) ON DELETE CASCADE,
  `media_file_id` text NOT NULL REFERENCES `media_files`(`id`) ON DELETE CASCADE,
  `state` text DEFAULT 'starting' NOT NULL,
  `started_at` text NOT NULL,
  `updated_at` text NOT NULL
);
