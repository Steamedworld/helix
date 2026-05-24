"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.playbackSessions = exports.watchStates = exports.mediaFiles = exports.mediaVersions = exports.mediaItems = exports.libraries = exports.users = exports.nodes = void 0;
const sqlite_core_1 = require("drizzle-orm/sqlite-core");
exports.nodes = (0, sqlite_core_1.sqliteTable)('nodes', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    name: (0, sqlite_core_1.text)('name').notNull(),
    kind: (0, sqlite_core_1.text)('kind', { enum: ['local', 'remote'] }).notNull().default('local'),
    base_url: (0, sqlite_core_1.text)('base_url'),
    status: (0, sqlite_core_1.text)('status', { enum: ['online', 'offline', 'unknown'] }).notNull().default('unknown'),
    created_at: (0, sqlite_core_1.text)('created_at').notNull(),
    updated_at: (0, sqlite_core_1.text)('updated_at').notNull(),
});
exports.users = (0, sqlite_core_1.sqliteTable)('users', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    display_name: (0, sqlite_core_1.text)('display_name').notNull(),
    role: (0, sqlite_core_1.text)('role', { enum: ['admin', 'user'] }).notNull().default('user'),
    created_at: (0, sqlite_core_1.text)('created_at').notNull(),
    updated_at: (0, sqlite_core_1.text)('updated_at').notNull(),
});
exports.libraries = (0, sqlite_core_1.sqliteTable)('libraries', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    node_id: (0, sqlite_core_1.text)('node_id').notNull().references(() => exports.nodes.id, { onDelete: 'cascade' }),
    name: (0, sqlite_core_1.text)('name').notNull(),
    kind: (0, sqlite_core_1.text)('kind', { enum: ['movies', 'tv', 'music', 'photos', 'other'] }).notNull().default('movies'),
    root_path: (0, sqlite_core_1.text)('root_path').notNull(),
    scan_status: (0, sqlite_core_1.text)('scan_status', { enum: ['idle', 'scanning', 'error'] }).notNull().default('idle'),
    created_at: (0, sqlite_core_1.text)('created_at').notNull(),
    updated_at: (0, sqlite_core_1.text)('updated_at').notNull(),
});
exports.mediaItems = (0, sqlite_core_1.sqliteTable)('media_items', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    library_id: (0, sqlite_core_1.text)('library_id').notNull().references(() => exports.libraries.id, { onDelete: 'cascade' }),
    kind: (0, sqlite_core_1.text)('kind', { enum: ['movie', 'show', 'season', 'episode', 'track', 'album', 'photo', 'other'] }).notNull().default('movie'),
    title: (0, sqlite_core_1.text)('title').notNull(),
    sort_title: (0, sqlite_core_1.text)('sort_title'),
    year: (0, sqlite_core_1.integer)('year'),
    external_tmdb_id: (0, sqlite_core_1.text)('external_tmdb_id'),
    external_tvdb_id: (0, sqlite_core_1.text)('external_tvdb_id'),
    external_musicbrainz_id: (0, sqlite_core_1.text)('external_musicbrainz_id'),
    created_at: (0, sqlite_core_1.text)('created_at').notNull(),
    updated_at: (0, sqlite_core_1.text)('updated_at').notNull(),
});
exports.mediaVersions = (0, sqlite_core_1.sqliteTable)('media_versions', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    media_item_id: (0, sqlite_core_1.text)('media_item_id').notNull().references(() => exports.mediaItems.id, { onDelete: 'cascade' }),
    label: (0, sqlite_core_1.text)('label'),
    quality_label: (0, sqlite_core_1.text)('quality_label'),
    resolution_width: (0, sqlite_core_1.integer)('resolution_width'),
    resolution_height: (0, sqlite_core_1.integer)('resolution_height'),
    video_codec: (0, sqlite_core_1.text)('video_codec'),
    audio_codec: (0, sqlite_core_1.text)('audio_codec'),
    container: (0, sqlite_core_1.text)('container'),
    duration_seconds: (0, sqlite_core_1.real)('duration_seconds'),
    created_at: (0, sqlite_core_1.text)('created_at').notNull(),
    updated_at: (0, sqlite_core_1.text)('updated_at').notNull(),
});
exports.mediaFiles = (0, sqlite_core_1.sqliteTable)('media_files', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    node_id: (0, sqlite_core_1.text)('node_id').notNull().references(() => exports.nodes.id, { onDelete: 'cascade' }),
    library_id: (0, sqlite_core_1.text)('library_id').notNull().references(() => exports.libraries.id, { onDelete: 'cascade' }),
    media_item_id: (0, sqlite_core_1.text)('media_item_id').notNull().references(() => exports.mediaItems.id, { onDelete: 'cascade' }),
    media_version_id: (0, sqlite_core_1.text)('media_version_id').notNull().references(() => exports.mediaVersions.id, { onDelete: 'cascade' }),
    path: (0, sqlite_core_1.text)('path').notNull().unique(),
    filename: (0, sqlite_core_1.text)('filename').notNull(),
    extension: (0, sqlite_core_1.text)('extension').notNull(),
    size_bytes: (0, sqlite_core_1.integer)('size_bytes'),
    file_hash: (0, sqlite_core_1.text)('file_hash'),
    discovered_at: (0, sqlite_core_1.text)('discovered_at').notNull(),
    updated_at: (0, sqlite_core_1.text)('updated_at').notNull(),
});
exports.watchStates = (0, sqlite_core_1.sqliteTable)('watch_states', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    user_id: (0, sqlite_core_1.text)('user_id').notNull().references(() => exports.users.id, { onDelete: 'cascade' }),
    media_item_id: (0, sqlite_core_1.text)('media_item_id').notNull().references(() => exports.mediaItems.id, { onDelete: 'cascade' }),
    position_seconds: (0, sqlite_core_1.real)('position_seconds').notNull().default(0),
    duration_seconds: (0, sqlite_core_1.real)('duration_seconds'),
    completed: (0, sqlite_core_1.integer)('completed', { mode: 'boolean' }).notNull().default(false),
    updated_at: (0, sqlite_core_1.text)('updated_at').notNull(),
});
exports.playbackSessions = (0, sqlite_core_1.sqliteTable)('playback_sessions', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    user_id: (0, sqlite_core_1.text)('user_id').notNull().references(() => exports.users.id, { onDelete: 'cascade' }),
    node_id: (0, sqlite_core_1.text)('node_id').notNull().references(() => exports.nodes.id, { onDelete: 'cascade' }),
    media_item_id: (0, sqlite_core_1.text)('media_item_id').notNull().references(() => exports.mediaItems.id, { onDelete: 'cascade' }),
    media_version_id: (0, sqlite_core_1.text)('media_version_id').notNull().references(() => exports.mediaVersions.id, { onDelete: 'cascade' }),
    media_file_id: (0, sqlite_core_1.text)('media_file_id').notNull().references(() => exports.mediaFiles.id, { onDelete: 'cascade' }),
    state: (0, sqlite_core_1.text)('state', { enum: ['starting', 'playing', 'paused', 'stopped', 'error'] }).notNull().default('starting'),
    started_at: (0, sqlite_core_1.text)('started_at').notNull(),
    updated_at: (0, sqlite_core_1.text)('updated_at').notNull(),
});
//# sourceMappingURL=schema.js.map