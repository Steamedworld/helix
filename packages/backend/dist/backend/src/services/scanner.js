"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanLibrary = scanLibrary;
const fs_1 = require("fs");
const path_1 = require("path");
const schema_1 = require("../db/schema");
const drizzle_orm_1 = require("drizzle-orm");
const logger_1 = require("../lib/logger");
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.aac', '.ogg', '.wav', '.m4a']);
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic']);
function normalizeTitle(raw) {
    return raw.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
}
function parseFilename(filename) {
    // Remove extension
    const noExt = filename.replace(/\.[^/.]+$/, '');
    const normalized = normalizeTitle(noExt);
    // Try "Title (Year)" pattern
    const parenMatch = normalized.match(/^(.+?)\s*\((\d{4})\)\s*(.*)$/);
    if (parenMatch) {
        const year = parseInt(parenMatch[2], 10);
        if (year >= 1900 && year <= 2099) {
            return { title: parenMatch[1].trim(), year };
        }
    }
    // Try "Title Year " or "Title.Year." pattern in normalized string
    const dotYearMatch = normalized.match(/^(.+?)\s+(\d{4})\b/);
    if (dotYearMatch) {
        const year = parseInt(dotYearMatch[2], 10);
        if (year >= 1900 && year <= 2099) {
            return { title: dotYearMatch[1].trim(), year };
        }
    }
    return { title: normalized, year: null };
}
function getMediaKind(ext) {
    if (VIDEO_EXTENSIONS.has(ext))
        return 'movie';
    if (AUDIO_EXTENSIONS.has(ext))
        return 'track';
    if (PHOTO_EXTENSIONS.has(ext))
        return 'photo';
    return 'other';
}
async function walkDirectory(dir) {
    const results = [];
    let entries;
    try {
        entries = await fs_1.promises.readdir(dir, { withFileTypes: true });
    }
    catch {
        logger_1.logger.warn({ dir }, 'Cannot read directory, skipping');
        return results;
    }
    for (const entry of entries) {
        const fullPath = (0, path_1.join)(dir, entry.name);
        if (entry.isDirectory()) {
            const subResults = await walkDirectory(fullPath);
            results.push(...subResults);
        }
        else if (entry.isFile()) {
            const ext = (0, path_1.extname)(entry.name).toLowerCase();
            if (VIDEO_EXTENSIONS.has(ext) ||
                AUDIO_EXTENSIONS.has(ext) ||
                PHOTO_EXTENSIONS.has(ext)) {
                results.push(fullPath);
            }
        }
    }
    return results;
}
async function scanLibrary(library, localNodeId, db) {
    const counts = { added: 0, updated: 0, skipped: 0 };
    logger_1.logger.info({ libraryId: library.id, path: library.root_path }, 'Starting scan');
    let files;
    try {
        files = await walkDirectory(library.root_path);
    }
    catch (e) {
        logger_1.logger.error({ err: e }, 'Failed to walk directory');
        return counts;
    }
    for (const filePath of files) {
        // Check if file already exists in DB
        const existing = await db
            .select({ id: schema_1.mediaFiles.id })
            .from(schema_1.mediaFiles)
            .where((0, drizzle_orm_1.eq)(schema_1.mediaFiles.path, filePath))
            .limit(1);
        if (existing.length > 0) {
            counts.skipped++;
            continue;
        }
        const filename = (0, path_1.basename)(filePath);
        const ext = (0, path_1.extname)(filename).toLowerCase();
        const kind = getMediaKind(ext);
        const { title, year } = parseFilename(filename);
        const now = new Date().toISOString();
        // Try to find an existing media item with the same title + year in this library
        let mediaItemId;
        const titleConditions = [
            (0, drizzle_orm_1.eq)(schema_1.mediaItems.title, title),
            (0, drizzle_orm_1.eq)(schema_1.mediaItems.library_id, library.id),
        ];
        const existingItem = await db
            .select({ id: schema_1.mediaItems.id })
            .from(schema_1.mediaItems)
            .where((0, drizzle_orm_1.and)(...titleConditions))
            .limit(1);
        if (existingItem.length > 0) {
            mediaItemId = existingItem[0].id;
        }
        else {
            mediaItemId = crypto.randomUUID();
            await db.insert(schema_1.mediaItems).values({
                id: mediaItemId,
                library_id: library.id,
                kind,
                title,
                sort_title: title.toLowerCase().replace(/^(the|a|an)\s+/i, ''),
                year: year ?? null,
                external_tmdb_id: null,
                external_tvdb_id: null,
                external_musicbrainz_id: null,
                created_at: now,
                updated_at: now,
            });
        }
        // Create media version
        const mediaVersionId = crypto.randomUUID();
        const container = ext.replace('.', '');
        await db.insert(schema_1.mediaVersions).values({
            id: mediaVersionId,
            media_item_id: mediaItemId,
            label: null,
            quality_label: null,
            resolution_width: null,
            resolution_height: null,
            video_codec: null,
            audio_codec: null,
            container,
            duration_seconds: null,
            created_at: now,
            updated_at: now,
        });
        // Get file stats
        let sizeBytes = null;
        try {
            const stat = await fs_1.promises.stat(filePath);
            sizeBytes = stat.size;
        }
        catch {
            // ignore
        }
        // Create media file
        await db.insert(schema_1.mediaFiles).values({
            id: crypto.randomUUID(),
            node_id: localNodeId,
            library_id: library.id,
            media_item_id: mediaItemId,
            media_version_id: mediaVersionId,
            path: filePath,
            filename,
            extension: ext,
            size_bytes: sizeBytes,
            file_hash: null,
            discovered_at: now,
            updated_at: now,
        });
        counts.added++;
    }
    logger_1.logger.info({ libraryId: library.id, ...counts }, 'Scan complete');
    return counts;
}
//# sourceMappingURL=scanner.js.map