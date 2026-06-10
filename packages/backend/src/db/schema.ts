import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['local', 'remote'] }).notNull().default('local'),
  base_url: text('base_url'),
  status: text('status', { enum: ['online', 'offline', 'unknown', 'error'] }).notNull().default('unknown'),
  api_token_encrypted: text('api_token_encrypted'),
  federation_token_hash: text('federation_token_hash'),
  last_seen_at: integer('last_seen_at'),
  last_sync_at: integer('last_sync_at'),
  last_error: text('last_error'),
  capabilities_json: text('capabilities_json'),
  last_sync_mode: text('last_sync_mode'),
  last_sync_fallback_reason: text('last_sync_fallback_reason'),
  last_sync_items_synced: integer('last_sync_items_synced').notNull().default(0),
  last_sync_versions_synced: integer('last_sync_versions_synced').notNull().default(0),
  last_sync_files_synced: integer('last_sync_files_synced').notNull().default(0),
  last_sync_tombstones_applied: integer('last_sync_tombstones_applied').notNull().default(0),
  last_sync_libraries_removed: integer('last_sync_libraries_removed').notNull().default(0),
  last_sync_items_removed: integer('last_sync_items_removed').notNull().default(0),
  last_sync_versions_removed: integer('last_sync_versions_removed').notNull().default(0),
  last_sync_files_removed: integer('last_sync_files_removed').notNull().default(0),
  last_sync_diagnostics_updated_at: text('last_sync_diagnostics_updated_at'),
  last_sync_attempt_at: text('last_sync_attempt_at'),
  last_sync_error_at: text('last_sync_error_at'),
  last_sync_error_code: text('last_sync_error_code'),
  last_sync_error_message: text('last_sync_error_message'),
  // Playback failure diagnostics — populated by the proxy stream handler
  last_playback_issue_at: text('last_playback_issue_at'),
  last_playback_issue_mode: text('last_playback_issue_mode'),
  last_playback_issue_code: text('last_playback_issue_code'),
  last_playback_issue_message: text('last_playback_issue_message'),
  // Federated watch-progress sync settings (both default to disabled — bilateral opt-in)
  progress_sync_enabled: integer('progress_sync_enabled').notNull().default(0),
  allow_progress_push: integer('allow_progress_push').notNull().default(0),
  allow_progress_receive: integer('allow_progress_receive').notNull().default(0),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  display_name: text('display_name').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  username: text('username').unique(),
  password_hash: text('password_hash'),
  disabled: integer('disabled').notNull().default(0),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token_hash: text('token_hash').notNull().unique(),
  created_at: integer('created_at').notNull(),
  expires_at: integer('expires_at').notNull(),
  last_seen_at: integer('last_seen_at').notNull(),
  user_agent: text('user_agent'),
  revoked_at: integer('revoked_at'),
})

export const libraries = sqliteTable('libraries', {
  id: text('id').primaryKey(),
  node_id: text('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['movies', 'tv', 'music', 'photos', 'other'] }).notNull().default('movies'),
  root_path: text('root_path').notNull(),
  scan_status: text('scan_status', { enum: ['idle', 'scanning', 'error'] }).notNull().default('idle'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const mediaItems = sqliteTable('media_items', {
  id: text('id').primaryKey(),
  library_id: text('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
  parent_id: text('parent_id'),
  kind: text('kind', { enum: ['movie', 'show', 'season', 'episode', 'track', 'album', 'photo', 'other'] }).notNull().default('movie'),
  title: text('title').notNull(),
  sort_title: text('sort_title'),
  year: integer('year'),
  overview: text('overview'),
  poster_path: text('poster_path'),
  backdrop_path: text('backdrop_path'),
  original_title: text('original_title'),
  release_date: text('release_date'),
  content_rating: text('content_rating'),
  runtime_seconds: integer('runtime_seconds'),
  season_number: integer('season_number'),
  episode_number: integer('episode_number'),
  episode_title: text('episode_title'),
  absolute_episode_number: integer('absolute_episode_number'),
  metadata_status: text('metadata_status', { enum: ['unknown', 'local', 'matched', 'needs_review', 'error'] }).notNull().default('unknown'),
  metadata_source: text('metadata_source'),
  metadata_updated_at: integer('metadata_updated_at'),
  external_tmdb_id: text('external_tmdb_id'),
  external_tvdb_id: text('external_tvdb_id'),
  external_musicbrainz_id: text('external_musicbrainz_id'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const mediaVersions = sqliteTable('media_versions', {
  id: text('id').primaryKey(),
  media_item_id: text('media_item_id').notNull().references(() => mediaItems.id, { onDelete: 'cascade' }),
  label: text('label'),
  quality_label: text('quality_label'),
  resolution_width: integer('resolution_width'),
  resolution_height: integer('resolution_height'),
  video_codec: text('video_codec'),
  audio_codec: text('audio_codec'),
  container: text('container'),
  duration_seconds: real('duration_seconds'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const mediaFiles = sqliteTable('media_files', {
  id: text('id').primaryKey(),
  node_id: text('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  library_id: text('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
  media_item_id: text('media_item_id').notNull().references(() => mediaItems.id, { onDelete: 'cascade' }),
  media_version_id: text('media_version_id').notNull().references(() => mediaVersions.id, { onDelete: 'cascade' }),
  path: text('path').notNull().unique(),
  filename: text('filename').notNull(),
  extension: text('extension').notNull(),
  size_bytes: integer('size_bytes'),
  file_hash: text('file_hash'),
  missing_at: integer('missing_at'),
  discovered_at: text('discovered_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const watchStates = sqliteTable('watch_states', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  media_item_id: text('media_item_id').notNull().references(() => mediaItems.id, { onDelete: 'cascade' }),
  position_seconds: real('position_seconds').notNull().default(0),
  duration_seconds: real('duration_seconds'),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  updated_at: text('updated_at').notNull(),
  // Viewer-side federated push sync status
  progress_push_status: text('progress_push_status'),
  progress_push_at: text('progress_push_at'),
  progress_push_error_code: text('progress_push_error_code'),
})

export const playbackSessions = sqliteTable('playback_sessions', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  node_id: text('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  media_item_id: text('media_item_id').notNull().references(() => mediaItems.id, { onDelete: 'cascade' }),
  media_version_id: text('media_version_id').notNull().references(() => mediaVersions.id, { onDelete: 'cascade' }),
  media_file_id: text('media_file_id').notNull().references(() => mediaFiles.id, { onDelete: 'cascade' }),
  state: text('state', { enum: ['starting', 'playing', 'paused', 'stopped', 'error'] }).notNull().default('starting'),
  started_at: text('started_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const integrations = sqliteTable('integrations', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['radarr', 'sonarr', 'lidarr', 'prowlarr', 'other'] }).notNull(),
  name: text('name').notNull(),
  base_url: text('base_url').notNull(),
  api_key_encrypted: text('api_key_encrypted').notNull(),
  enabled: integer('enabled').notNull().default(1),
  status: text('status', { enum: ['unknown', 'online', 'offline', 'error'] }).notNull().default('unknown'),
  last_checked_at: integer('last_checked_at'),
  last_synced_at: integer('last_synced_at'),
  last_error: text('last_error'),
  webhook_enabled: integer('webhook_enabled').notNull().default(0),
  webhook_secret_hash: text('webhook_secret_hash'),
  last_webhook_at: integer('last_webhook_at'),
  last_webhook_event: text('last_webhook_event'),
  last_webhook_error: text('last_webhook_error'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

export const enrichmentJobs = sqliteTable('enrichment_jobs', {
  id: text('id').primaryKey(),
  media_item_id: text('media_item_id').notNull().references(() => mediaItems.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  max_attempts: integer('max_attempts').notNull().default(3),
  last_error: text('last_error'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

export const libraryPermissions = sqliteTable('library_permissions', {
  id: text('id').primaryKey(),
  library_id: text('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  can_view: integer('can_view', { mode: 'boolean' }).notNull().default(true),
  can_play: integer('can_play', { mode: 'boolean' }).notNull().default(true),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
}, (t) => ({
  unique_user_library: uniqueIndex('idx_lib_perms_unique').on(t.library_id, t.user_id),
  idx_user: index('idx_lib_perms_user').on(t.user_id),
}))

export const externalMediaLinks = sqliteTable('external_media_links', {
  id: text('id').primaryKey(),
  media_item_id: text('media_item_id').notNull().references(() => mediaItems.id, { onDelete: 'cascade' }),
  integration_id: text('integration_id').notNull().references(() => integrations.id, { onDelete: 'cascade' }),
  external_kind: text('external_kind', { enum: ['radarr_movie', 'sonarr_series', 'sonarr_episode'] }).notNull(),
  external_id: text('external_id').notNull(),
  external_guid: text('external_guid'),
  external_title: text('external_title'),
  monitored: integer('monitored'),
  quality_profile: text('quality_profile'),
  root_path: text('root_path'),
  last_synced_at: integer('last_synced_at'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

export const catalogTombstones = sqliteTable('catalog_tombstones', {
  id: text('id').primaryKey(),
  node_id: text('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  entity_type: text('entity_type', { enum: ['library', 'media_item', 'media_version', 'media_file'] }).notNull(),
  entity_id: text('entity_id').notNull(),
  deleted_at: text('deleted_at').notNull(),
  reason: text('reason', { enum: ['scan_missing', 'integration_delete', 'admin_disconnect', 'unknown'] }),
  created_at: text('created_at').notNull(),
}, (t) => ({
  idx_node_deleted: index('idx_tombstones_node_deleted').on(t.node_id, t.deleted_at),
  idx_entity: index('idx_tombstones_entity').on(t.entity_type, t.entity_id),
  idx_deleted_at: index('idx_tombstones_deleted_at').on(t.deleted_at),
}))

export const trustedHomeInvites = sqliteTable('trusted_home_invites', {
  id: text('id').primaryKey(),
  token_hash: text('token_hash').notNull().unique(),
  label: text('label'),
  expires_at: integer('expires_at'),
  used_at: integer('used_at'),
  revoked_at: integer('revoked_at'),
  used_by_home_name: text('used_by_home_name'),
  used_by_address: text('used_by_address'),
  created_by_user_id: text('created_by_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (t) => ({
  idx_token_hash: uniqueIndex('idx_invites_token_hash').on(t.token_hash),
}))

/**
 * Remote watch-progress records.
 *
 * Source-side: progress entries pushed from a viewer Trusted Home.
 * identity: the calling Home sends no local user ID; we derive a stable
 * viewer hash from the caller's node ID (and optional clientEventId) so
 * all progress from one node maps to one pseudo-viewer.
 *
 * MUST NOT store: viewer session ID, local user IDs of the source Home,
 * filesystem paths, federation token values, or Authorization header contents.
 */
/**
 * Durable outbox for federated progress push jobs.
 *
 * Viewer-side: each row is a pending push to a source Trusted Home.
 * Worker processes rows in status 'pending'/'failed' up to max_attempts.
 *
 * MUST NOT store: user_id, federation token, raw URL, username, email,
 * filesystem path, Authorization header, or raw error body.
 */
export const federatedProgressOutbox = sqliteTable('federated_progress_outbox', {
  id: text('id').primaryKey(),
  node_id: text('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  media_id: text('media_id').notNull(),
  client_event_id: text('client_event_id').notNull(),
  position_seconds: real('position_seconds').notNull(),
  duration_seconds: real('duration_seconds'),
  watched: integer('watched').notNull().default(0),
  local_updated_at: text('local_updated_at').notNull(),
  attempt_count: integer('attempt_count').notNull().default(0),
  max_attempts: integer('max_attempts').notNull().default(3),
  status: text('status', { enum: ['pending', 'in_progress', 'synced', 'failed', 'abandoned'] })
    .notNull()
    .default('pending'),
  next_attempt_at: text('next_attempt_at').notNull(),
  last_attempt_at: text('last_attempt_at'),
  last_error_code: text('last_error_code'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
}, (t) => ({
  idx_status_next: index('idx_fpo_status_next').on(t.status, t.next_attempt_at),
  idx_node: index('idx_fpo_node').on(t.node_id, t.status),
  unique_node_media_event: uniqueIndex('idx_fpo_unique').on(t.node_id, t.media_id, t.client_event_id),
}))

/**
 * Privacy-safe audit trail for Trusted Home operations.
 *
 * Best-effort, non-blocking — a write failure here MUST NOT break any primary operation.
 *
 * MUST NOT store: user_id, local user ID, federation token, remote_viewer_hash,
 * raw URL, filesystem path, Authorization header, raw error body, stack trace,
 * username, email, or credential material of any kind.
 * node_id is a safe UUID reference (not a credential).
 */
export const trustedHomeAuditEvents = sqliteTable('trusted_home_audit_events', {
  id: text('id').primaryKey(),
  occurred_at: text('occurred_at').notNull(),
  action: text('action', {
    enum: [
      'trusted_home_settings_changed',
      'progress_push_enqueued',
      'progress_push_synced',
      'progress_push_abandoned',
      'progress_push_failed',
      'remote_progress_read_denied',
      'remote_progress_received',
      'playback_proxy_attempt',
    ],
  }).notNull(),
  result: text('result', { enum: ['success', 'denied', 'skipped', 'error'] }).notNull(),
  reason_code: text('reason_code'),
  node_id: text('node_id'),
  context_json: text('context_json'),
  created_at: text('created_at').notNull(),
}, (t) => ({
  idx_occurred_at: index('idx_audit_occurred_at').on(t.occurred_at),
  idx_action: index('idx_audit_action').on(t.action),
  idx_node: index('idx_audit_node').on(t.node_id),
}))

export const remoteWatchProgress = sqliteTable('remote_watch_progress', {
  id: text('id').primaryKey(),
  source_node_id: text('source_node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  remote_viewer_hash: text('remote_viewer_hash').notNull(),
  media_item_id: text('media_item_id').notNull().references(() => mediaItems.id, { onDelete: 'cascade' }),
  position_seconds: real('position_seconds').notNull().default(0),
  duration_seconds: real('duration_seconds'),
  watched: integer('watched').notNull().default(0),
  updated_at: text('updated_at').notNull(),
  client_event_id: text('client_event_id'),
  created_at: text('created_at').notNull(),
}, (t) => ({
  unique_viewer_media: uniqueIndex('idx_remote_progress_unique').on(t.source_node_id, t.remote_viewer_hash, t.media_item_id),
  idx_node: index('idx_remote_progress_node').on(t.source_node_id),
  idx_media: index('idx_remote_progress_media').on(t.media_item_id, t.source_node_id),
}))
