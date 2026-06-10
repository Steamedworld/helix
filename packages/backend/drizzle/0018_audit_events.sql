-- trusted_home_audit_events: privacy-safe audit trail for Trusted Home operations.
-- Best-effort, non-blocking — failures here must never break primary operations.
-- MUST NOT store: user_id, local user ID, federation token, remote_viewer_hash,
-- raw URL, filesystem path, Authorization header, raw error body, stack trace,
-- username, email, or credential material of any kind.
CREATE TABLE IF NOT EXISTS `trusted_home_audit_events` (
  `id` text PRIMARY KEY,
  `occurred_at` text NOT NULL,
  `action` text NOT NULL
    CHECK(`action` IN (
      'trusted_home_settings_changed',
      'progress_push_enqueued',
      'progress_push_synced',
      'progress_push_abandoned',
      'progress_push_failed',
      'remote_progress_read_denied',
      'remote_progress_received',
      'playback_proxy_attempt'
    )),
  `result` text NOT NULL CHECK(`result` IN ('success','denied','skipped','error')),
  `reason_code` text,
  `node_id` text,
  `context_json` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_occurred_at` ON `trusted_home_audit_events`(`occurred_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_action` ON `trusted_home_audit_events`(`action`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_node` ON `trusted_home_audit_events`(`node_id`);
