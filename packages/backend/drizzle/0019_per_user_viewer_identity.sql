-- Per-user viewer identity v1 — optional, bilateral, opt-in per-user federated progress identity.
-- Per-node aggregate identity remains the default. Per-user is used only when BOTH Homes opt in.
--
-- allow_progress_user_identity: bilateral opt-in flag (viewer gates sending, source gates accepting/storing).
-- viewer_identity_kind: read-scoping safety rail on stored progress ('node' aggregate | 'user' per-user).
-- viewer_identity_hash: nullable opaque HMAC carrier on outbox jobs. NULL ⇒ node_v1. No user_id ever stored.
ALTER TABLE `nodes` ADD COLUMN `allow_progress_user_identity` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `remote_watch_progress` ADD COLUMN `viewer_identity_kind` text NOT NULL DEFAULT 'node';
--> statement-breakpoint
ALTER TABLE `federated_progress_outbox` ADD COLUMN `viewer_identity_hash` text;
