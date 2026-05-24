import { promises as fs } from 'fs'
import { join, extname, basename } from 'path'
import type { DrizzleDB } from '../db/client'
import { mediaItems, mediaVersions, mediaFiles } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import type { Library, MediaItemKind } from '@helix/shared'
import { logger } from '../lib/logger'

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.aac', '.ogg', '.wav', '.m4a'])
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'])

interface ParsedTitle {
  title: string
  year: number | null
}

function normalizeTitle(raw: string): string {
  return raw.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseFilename(filename: string): ParsedTitle {
  // Remove extension
  const noExt = filename.replace(/\.[^/.]+$/, '')
  const normalized = normalizeTitle(noExt)

  // Try "Title (Year)" pattern
  const parenMatch = normalized.match(/^(.+?)\s*\((\d{4})\)\s*(.*)$/)
  if (parenMatch) {
    const year = parseInt(parenMatch[2], 10)
    if (year >= 1900 && year <= 2099) {
      return { title: parenMatch[1].trim(), year }
    }
  }

  // Try "Title Year " or "Title.Year." pattern in normalized string
  const dotYearMatch = normalized.match(/^(.+?)\s+(\d{4})\b/)
  if (dotYearMatch) {
    const year = parseInt(dotYearMatch[2], 10)
    if (year >= 1900 && year <= 2099) {
      return { title: dotYearMatch[1].trim(), year }
    }
  }

  return { title: normalized, year: null }
}

function getMediaKind(ext: string): MediaItemKind {
  if (VIDEO_EXTENSIONS.has(ext)) return 'movie'
  if (AUDIO_EXTENSIONS.has(ext)) return 'track'
  if (PHOTO_EXTENSIONS.has(ext)) return 'photo'
  return 'other'
}

async function walkDirectory(dir: string): Promise<string[]> {
  const results: string[] = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    logger.warn({ dir }, 'Cannot read directory, skipping')
    return results
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const subResults = await walkDirectory(fullPath)
      results.push(...subResults)
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase()
      if (
        VIDEO_EXTENSIONS.has(ext) ||
        AUDIO_EXTENSIONS.has(ext) ||
        PHOTO_EXTENSIONS.has(ext)
      ) {
        results.push(fullPath)
      }
    }
  }
  return results
}

export async function scanLibrary(
  library: Library,
  localNodeId: string,
  db: DrizzleDB
): Promise<{ added: number; updated: number; skipped: number }> {
  const counts = { added: 0, updated: 0, skipped: 0 }

  logger.info({ libraryId: library.id, path: library.root_path }, 'Starting scan')

  let files: string[]
  try {
    files = await walkDirectory(library.root_path)
  } catch (e) {
    logger.error({ err: e }, 'Failed to walk directory')
    return counts
  }

  for (const filePath of files) {
    // Check if file already exists in DB
    const existing = await db
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .where(eq(mediaFiles.path, filePath))
      .limit(1)

    if (existing.length > 0) {
      counts.skipped++
      continue
    }

    const filename = basename(filePath)
    const ext = extname(filename).toLowerCase()
    const kind = getMediaKind(ext)
    const { title, year } = parseFilename(filename)
    const now = new Date().toISOString()

    // Try to find an existing media item with the same title + year in this library
    let mediaItemId: string
    const titleConditions = [
      eq(mediaItems.title, title),
      eq(mediaItems.library_id, library.id),
    ]
    const existingItem = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(...titleConditions))
      .limit(1)

    if (existingItem.length > 0) {
      mediaItemId = existingItem[0].id
    } else {
      mediaItemId = crypto.randomUUID()
      await db.insert(mediaItems).values({
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
      })
    }

    // Create media version
    const mediaVersionId = crypto.randomUUID()
    const container = ext.replace('.', '')
    await db.insert(mediaVersions).values({
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
    })

    // Get file stats
    let sizeBytes: number | null = null
    try {
      const stat = await fs.stat(filePath)
      sizeBytes = stat.size
    } catch {
      // ignore
    }

    // Create media file
    await db.insert(mediaFiles).values({
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
    })

    counts.added++
  }

  logger.info({ libraryId: library.id, ...counts }, 'Scan complete')
  return counts
}
