-- Durable federated progress push outbox
-- Stores pending push jobs for retry with bounded attempts.
-- MUST NOT contain: user_id, federation token, raw URL, username, email,
-- filesystem path, Authorization header, or raw error body.
CREATE TABLE IF NOT EXISTS `federated_progress_outbox` (
  `id` text PRIMARY KEY,
  `node_id` text NOT NULL REFERENCES `nodes`(`id`) ON DELETE CASCADE,
  `media_id` text NOT NULL,
  `client_event_id` text NOT NULL,
  `position_seconds` real NOT NULL,
  `duration_seconds` real,
  `watched` integer NOT NULL DEFAULT 0,
  `local_updated_at` text NOT NULL,
  `attempt_count` integer NOT NULL DEFAULT 0,
  `max_attempts` integer NOT NULL DEFAULT 3,
  `status` text NOT NULL DEFAULT 'pending'
    CHECK(`status` IN ('pending','in_progress','synced','failed','abandoned')),
  `next_attempt_at` text NOT NULL,
  `last_attempt_at` text,
  `last_error_code` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  UNIQUE(`node_id`, `media_id`, `client_event_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_fpo_status_next` ON `federated_progress_outbox`(`status`, `next_attempt_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_fpo_node` ON `federated_progress_outbox`(`node_id`, `status`);
