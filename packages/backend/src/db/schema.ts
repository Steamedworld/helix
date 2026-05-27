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
