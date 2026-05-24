import { promises as fs } from 'fs'
import { join, extname, basename, dirname } from 'path'
import type { DrizzleDB } from '../db/client'
import { mediaItems, mediaVersions, mediaFiles, libraries } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import type { Library, MediaItemKind } from '@helix/shared'
import { logger } from '../lib/logger'

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.aac', '.ogg', '.wav', '.m4a'])
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'])
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png']

// ─── Filename Metadata Parsing ─────────────────────────────────────────────────

export type QualityLabel = '4K' | '1080p' | '720p' | '480p' | 'SD'

export interface ParsedFilename {
  title: string
  year: number | null
  season: number | null
  episode: number | null
  episodeTitle: string | null
  qualityLabel: QualityLabel | null
  resolutionWidth: number | null
  resolutionHeight: number | null
  container: string
  videoCodec: string | null
  audioCodec: string | null
}

function normalizeTitle(raw: string): string {
  return raw.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim()
}

function extractQualityLabel(name: string): QualityLabel | null {
  if (/\b2160p\b/i.test(name) || /\b4k\b/i.test(name) || /\bUHD\b/i.test(name)) return '4K'
  if (/\b1080p\b/i.test(name) || /\b1080i\b/i.test(name)) return '1080p'
  if (/\b720p\b/i.test(name)) return '720p'
  if (/\b480p\b/i.test(name)) return '480p'
  return null
}

function qualityLabelToResolution(label: QualityLabel | null): { w: number; h: number } | null {
  switch (label) {
    case '4K': return { w: 3840, h: 2160 }
    case '1080p': return { w: 1920, h: 1080 }
    case '720p': return { w: 1280, h: 720 }
    case '480p': return { w: 720, h: 480 }
    default: return null
  }
}

function extractVideoCodec(name: string): string | null {
  // Order matters — check more specific patterns first
  if (/\bx265\b/i.test(name) || /\bH\.?265\b/i.test(name) || /\bHEVC\b/i.test(name)) return 'H.265'
  if (/\bx264\b/i.test(name) || /\bH\.?264\b/i.test(name) || /\bAVC\b/i.test(name)) return 'H.264'
  if (/\bAV1\b/i.test(name)) return 'AV1'
  if (/\bVP9\b/i.test(name)) return 'VP9'
  return null
}

function extractAudioCodec(name: string): string | null {
  if (/\bTrueHD\b/i.test(name) || /\bAtmos\b/i.test(name)) return 'TrueHD'
  if (/\bDTS[-‐]?HD\b/i.test(name)) return 'DTS-HD'
  if (/\bDTS\b/i.test(name)) return 'DTS'
  if (/\bAC3\b/i.test(name) || /\bDolby\b/i.test(name)) return 'AC3'
  if (/\bFLAC\b/i.test(name)) return 'FLAC'
  if (/\bAAC\b/i.test(name)) return 'AAC'
  if (/\bMP3\b/i.test(name)) return 'MP3'
  return null
}

// Trim known technical suffixes from normalized title tokens
// Stops at quality markers, source tags, codec tags, etc.
const STOP_PATTERN = /^(2160p|1080p|1080i|720p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|web-dl|webrip|hdtv|dvdrip|dvd|x265|x264|h264|h265|hevc|avc|av1|vp9|aac|ac3|dts|flac|mp3|truehd|atmos|proper|repack|extended|theatrical|directors|cut|remastered|remux)$/i

function trimStopWords(tokens: string[]): string[] {
  const out: string[] = []
  for (const t of tokens) {
    if (STOP_PATTERN.test(t)) break
    out.push(t)
  }
  return out
}

export function parseFilename(filename: string): ParsedFilename {
  const ext = extname(filename).toLowerCase()
  const container = ext.replace('.', '') || 'unknown'
  const noExt = filename.slice(0, filename.length - ext.length)

  const qualityLabel = extractQualityLabel(noExt)
  const videoCodec = extractVideoCodec(noExt)
  const audioCodec = extractAudioCodec(noExt)
  const res = qualityLabelToResolution(qualityLabel)

  // ── TV show patterns ────────────────────────────────────────────────────────
  // Pattern: "Show.Name.S01E02.Episode.Title.1080p.mkv"
  // Pattern: "Show Name - S01E02 - Episode Title.mkv"
  const tvPattern = /^(.+?)[.\s-]+[Ss](\d{1,2})[Ee](\d{1,2})(?:[.\s-]+(.+?))?(?:[.\s]*(?:2160p|1080p|1080i|720p|480p|4k|uhd|bluray|bdrip|web-dl|webrip|hdtv|dvdrip|x265|x264|h264|h265|hevc|avc|aac|ac3|dts|flac|proper|repack).*)?$/i
  const tvMatch = noExt.match(tvPattern)
  if (tvMatch) {
    const rawTitle = normalizeTitle(tvMatch[1])
    const season = parseInt(tvMatch[2], 10)
    const episode = parseInt(tvMatch[3], 10)
    const rawEpTitle = tvMatch[4] ? normalizeTitle(tvMatch[4].replace(/[.\s-]+$/, '')) : null
    // Strip stop words from episode title
    const epTitle = rawEpTitle
      ? trimStopWords(rawEpTitle.split(' ')).join(' ').trim() || null
      : null

    return {
      title: rawTitle,
      year: null,
      season,
      episode,
      episodeTitle: epTitle,
      qualityLabel,
      resolutionWidth: res?.w ?? null,
      resolutionHeight: res?.h ?? null,
      container,
      videoCodec,
      audioCodec,
    }
  }

  // ── Movie patterns ──────────────────────────────────────────────────────────
  // Pattern: "Movie Name (2020).mkv"
  const parenMatch = noExt.match(/^(.+?)\s*\((\d{4})\)/)
  if (parenMatch) {
    const year = parseInt(parenMatch[2], 10)
    if (year >= 1888 && year <= 2099) {
      return {
        title: normalizeTitle(parenMatch[1]).trim(),
        year,
        season: null,
        episode: null,
        episodeTitle: null,
        qualityLabel,
        resolutionWidth: res?.w ?? null,
        resolutionHeight: res?.h ?? null,
        container,
        videoCodec,
        audioCodec,
      }
    }
  }

  // Pattern: "Movie.Name.2020.1080p.mkv" or "Movie.Name.2020.mkv"
  // The year appears after the title, possibly before quality markers
  const normalized = normalizeTitle(noExt)
  const tokens = normalized.split(' ')

  // Find year token
  let yearIdx = -1
  for (let i = 1; i < tokens.length; i++) {
    const num = parseInt(tokens[i], 10)
    if (/^\d{4}$/.test(tokens[i]) && num >= 1888 && num <= 2099) {
      yearIdx = i
      break
    }
  }

  if (yearIdx > 0) {
    const year = parseInt(tokens[yearIdx], 10)
    const titleTokens = trimStopWords(tokens.slice(0, yearIdx))
    return {
      title: titleTokens.join(' ').trim() || normalized,
      year,
      season: null,
      episode: null,
      episodeTitle: null,
      qualityLabel,
      resolutionWidth: res?.w ?? null,
      resolutionHeight: res?.h ?? null,
      container,
      videoCodec,
      audioCodec,
    }
  }

  // Fallback: just use the normalized name without stop words
  const fallbackTitle = trimStopWords(tokens).join(' ').trim() || normalized
  return {
    title: fallbackTitle,
    year: null,
    season: null,
    episode: null,
    episodeTitle: null,
    qualityLabel,
    resolutionWidth: res?.w ?? null,
    resolutionHeight: res?.h ?? null,
    container,
    videoCodec,
    audioCodec,
  }
}

// ─── Artwork Detection ─────────────────────────────────────────────────────────

export interface ArtworkPaths {
  posterPath: string | null
  backdropPath: string | null
}

async function fileExistsAsync(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function detectLocalArtwork(
  directory: string,
  titleForMatch: string
): Promise<ArtworkPaths> {
  // Sanitize title for filename matching: lowercase, replace spaces with dots/spaces
  const titleSlug = titleForMatch.toLowerCase().replace(/\s+/g, '.')

  // Poster candidates in priority order
  const posterCandidates = [
    'poster.jpg', 'poster.jpeg', 'poster.png',
    'cover.jpg', 'cover.jpeg', 'cover.png',
    'folder.jpg', 'folder.jpeg', 'folder.png',
    `${titleSlug}.jpg`, `${titleSlug}.jpeg`, `${titleSlug}.png`,
    // also try space version
    `${titleForMatch.toLowerCase()}.jpg`,
    `${titleForMatch.toLowerCase()}.jpeg`,
    `${titleForMatch.toLowerCase()}.png`,
  ]

  const backdropCandidates = [
    'backdrop.jpg', 'backdrop.jpeg', 'backdrop.png',
    'fanart.jpg', 'fanart.jpeg', 'fanart.png',
  ]

  let posterPath: string | null = null
  for (const name of posterCandidates) {
    const p = join(directory, name)
    if (await fileExistsAsync(p)) {
      posterPath = p
      break
    }
    // Case-insensitive: try listing dir entries
  }

  let backdropPath: string | null = null
  for (const name of backdropCandidates) {
    const p = join(directory, name)
    if (await fileExistsAsync(p)) {
      backdropPath = p
      break
    }
  }

  return { posterPath, backdropPath }
}

// ─── Directory Walker ──────────────────────────────────────────────────────────

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

// ─── Stale-File Detection ──────────────────────────────────────────────────────

async function markStaleFiles(
  libraryId: string,
  foundPaths: Set<string>,
  db: DrizzleDB
): Promise<void> {
  // Get all media_files for this library
  const existingFiles = await db
    .select({
      id: mediaFiles.id,
      path: mediaFiles.path,
      missing_at: mediaFiles.missing_at,
    })
    .from(mediaFiles)
    .where(eq(mediaFiles.library_id, libraryId))

  const now = Date.now()

  for (const file of existingFiles) {
    const existsOnDisk = foundPaths.has(file.path)
    if (!existsOnDisk && file.missing_at === null) {
      // File disappeared — mark it
      await db
        .update(mediaFiles)
        .set({ missing_at: now, updated_at: new Date().toISOString() })
        .where(eq(mediaFiles.id, file.id))
      logger.info({ path: file.path }, 'Marked file as missing')
    } else if (existsOnDisk && file.missing_at !== null) {
      // File reappeared — clear missing_at
      await db
        .update(mediaFiles)
        .set({ missing_at: null, updated_at: new Date().toISOString() })
        .where(eq(mediaFiles.id, file.id))
      logger.info({ path: file.path }, 'File reappeared, cleared missing_at')
    }
  }
}

// ─── TV Hierarchy Helpers ──────────────────────────────────────────────────────

// Normalize a show title for matching (lowercase, collapse spaces)
function normalizeShowTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim()
}

async function findOrCreateShow(
  db: DrizzleDB,
  libraryId: string,
  showTitle: string,
  artworkPaths: ArtworkPaths,
  now: string,
  nowMs: number
): Promise<string> {
  const normalizedTitle = normalizeShowTitle(showTitle)

  // Find existing show with same title in this library
  const existing = await db
    .select({ id: mediaItems.id, metadata_status: mediaItems.metadata_status, poster_path: mediaItems.poster_path, backdrop_path: mediaItems.backdrop_path })
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.library_id, libraryId),
        eq(mediaItems.kind, 'show'),
        eq(mediaItems.title, showTitle)
      )
    )
    .limit(1)

  if (existing.length > 0) {
    const show = existing[0]
    // Update artwork if not already present
    const artworkUpdate: Record<string, unknown> = {}
    if (!show.poster_path && artworkPaths.posterPath) {
      artworkUpdate.poster_path = artworkPaths.posterPath
    }
    if (!show.backdrop_path && artworkPaths.backdropPath) {
      artworkUpdate.backdrop_path = artworkPaths.backdropPath
    }
    if (Object.keys(artworkUpdate).length > 0) {
      artworkUpdate.updated_at = now
      await db.update(mediaItems).set(artworkUpdate).where(eq(mediaItems.id, show.id))
    }
    return show.id
  }

  const id = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id,
    library_id: libraryId,
    parent_id: null,
    kind: 'show',
    title: showTitle,
    sort_title: normalizedTitle.replace(/^(the|a|an)\s+/i, ''),
    year: null,
    overview: null,
    poster_path: artworkPaths.posterPath,
    backdrop_path: artworkPaths.backdropPath,
    original_title: null,
    release_date: null,
    content_rating: null,
    runtime_seconds: null,
    season_number: null,
    episode_number: null,
    episode_title: null,
    absolute_episode_number: null,
    metadata_status: 'local',
    metadata_source: 'filename',
    metadata_updated_at: nowMs,
    external_tmdb_id: null,
    external_tvdb_id: null,
    external_musicbrainz_id: null,
    created_at: now,
    updated_at: now,
  })
  return id
}

async function findOrCreateSeason(
  db: DrizzleDB,
  libraryId: string,
  showId: string,
  seasonNumber: number,
  now: string,
  nowMs: number
): Promise<string> {
  const existing = await db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.parent_id, showId),
        eq(mediaItems.kind, 'season'),
        eq(mediaItems.season_number, seasonNumber)
      )
    )
    .limit(1)

  if (existing.length > 0) {
    return existing[0].id
  }

  const id = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id,
    library_id: libraryId,
    parent_id: showId,
    kind: 'season',
    title: `Season ${seasonNumber}`,
    sort_title: `season ${seasonNumber.toString().padStart(4, '0')}`,
    year: null,
    overview: null,
    poster_path: null,
    backdrop_path: null,
    original_title: null,
    release_date: null,
    content_rating: null,
    runtime_seconds: null,
    season_number: seasonNumber,
    episode_number: null,
    episode_title: null,
    absolute_episode_number: null,
    metadata_status: 'local',
    metadata_source: 'filename',
    metadata_updated_at: nowMs,
    external_tmdb_id: null,
    external_tvdb_id: null,
    external_musicbrainz_id: null,
    created_at: now,
    updated_at: now,
  })
  return id
}

async function findOrCreateEpisode(
  db: DrizzleDB,
  libraryId: string,
  seasonId: string,
  seasonNumber: number,
  episodeNumber: number,
  episodeTitle: string | null,
  now: string,
  nowMs: number
): Promise<string> {
  const existing = await db
    .select({ id: mediaItems.id, metadata_status: mediaItems.metadata_status })
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.parent_id, seasonId),
        eq(mediaItems.kind, 'episode'),
        eq(mediaItems.episode_number, episodeNumber)
      )
    )
    .limit(1)

  if (existing.length > 0) {
    const ep = existing[0]
    const isEnriched = ep.metadata_status === 'matched' || ep.metadata_status === 'needs_review'
    if (!isEnriched && episodeTitle) {
      // Update episode title if we have one and not enriched
      await db.update(mediaItems)
        .set({ episode_title: episodeTitle, updated_at: now })
        .where(eq(mediaItems.id, ep.id))
    }
    return ep.id
  }

  const title = episodeTitle ?? `Episode ${episodeNumber}`
  const id = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id,
    library_id: libraryId,
    parent_id: seasonId,
    kind: 'episode',
    title,
    sort_title: `s${seasonNumber.toString().padStart(2, '0')}e${episodeNumber.toString().padStart(3, '0')}`,
    year: null,
    overview: null,
    poster_path: null,
    backdrop_path: null,
    original_title: null,
    release_date: null,
    content_rating: null,
    runtime_seconds: null,
    season_number: seasonNumber,
    episode_number: episodeNumber,
    episode_title: episodeTitle,
    absolute_episode_number: null,
    metadata_status: 'local',
    metadata_source: 'filename',
    metadata_updated_at: nowMs,
    external_tmdb_id: null,
    external_tvdb_id: null,
    external_musicbrainz_id: null,
    created_at: now,
    updated_at: now,
  })
  return id
}

// ─── Main Scanner ──────────────────────────────────────────────────────────────

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

  const foundPaths = new Set(files)

  // Mark stale / recover files
  await markStaleFiles(library.id, foundPaths, db)

  // Track directories we've already done artwork detection for
  const artworkCache = new Map<string, ArtworkPaths>()

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
    const parsed = parseFilename(filename)
    const {
      title,
      year,
      season,
      episode,
      episodeTitle,
      qualityLabel,
      resolutionWidth,
      resolutionHeight,
      container,
      videoCodec,
      audioCodec,
    } = parsed
    const now = new Date().toISOString()
    const nowMs = Date.now()

    // ── TV episode branch ────────────────────────────────────────────────────
    if (season !== undefined && season !== null && episode !== undefined && episode !== null) {
      // Artwork detection for show-level directory (parent of season dir)
      const episodeDir = dirname(filePath)
      const seasonDir = episodeDir
      // Look for show-level artwork in parent directories
      const showDir = dirname(seasonDir)
      const showArtworkDir = showDir !== library.root_path ? showDir : seasonDir

      if (!artworkCache.has(showArtworkDir)) {
        const artwork = await detectLocalArtwork(showArtworkDir, title)
        artworkCache.set(showArtworkDir, artwork)
      }
      const showArtwork = artworkCache.get(showArtworkDir)!

      // Find or create show
      const showId = await findOrCreateShow(
        db, library.id, title, showArtwork, now, nowMs
      )

      // Find or create season
      const seasonId = await findOrCreateSeason(
        db, library.id, showId, season, now, nowMs
      )

      // Find or create episode
      const episodeId = await findOrCreateEpisode(
        db, library.id, seasonId, season, episode, episodeTitle, now, nowMs
      )

      // Create media version attached to episode
      const mediaVersionId = crypto.randomUUID()
      await db.insert(mediaVersions).values({
        id: mediaVersionId,
        media_item_id: episodeId,
        label: null,
        quality_label: qualityLabel,
        resolution_width: resolutionWidth,
        resolution_height: resolutionHeight,
        video_codec: videoCodec,
        audio_codec: audioCodec,
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

      // Create media file attached to episode
      await db.insert(mediaFiles).values({
        id: crypto.randomUUID(),
        node_id: localNodeId,
        library_id: library.id,
        media_item_id: episodeId,
        media_version_id: mediaVersionId,
        path: filePath,
        filename,
        extension: ext,
        size_bytes: sizeBytes,
        file_hash: null,
        missing_at: null,
        discovered_at: now,
        updated_at: now,
      })

      counts.added++
      continue
    }

    // ── Movie / other branch ─────────────────────────────────────────────────
    const kind = getMediaKind(ext)

    // Artwork detection — cache per directory
    const fileDir = dirname(filePath)
    if (!artworkCache.has(fileDir)) {
      const artwork = await detectLocalArtwork(fileDir, title)
      artworkCache.set(fileDir, artwork)
    }
    const artwork = artworkCache.get(fileDir)!

    // Try to find an existing media item with the same title (+ year if present) in this library
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
      // Check metadata status — if matched/needs_review, do not overwrite enriched fields.
      // Only update artwork paths if no path is already set (local artwork wins).
      const [existingFull] = await db
        .select({
          metadata_status: mediaItems.metadata_status,
          poster_path: mediaItems.poster_path,
          backdrop_path: mediaItems.backdrop_path,
        })
        .from(mediaItems)
        .where(eq(mediaItems.id, mediaItemId))

      const isEnriched =
        existingFull?.metadata_status === 'matched' ||
        existingFull?.metadata_status === 'needs_review'

      // Build artwork update: only set if not already present
      const artworkUpdate: Record<string, unknown> = {}
      if (!existingFull?.poster_path && artwork.posterPath) {
        artworkUpdate.poster_path = artwork.posterPath
      }
      if (!existingFull?.backdrop_path && artwork.backdropPath) {
        artworkUpdate.backdrop_path = artwork.backdropPath
      }

      if (isEnriched) {
        // Only update non-enriched fields: artwork (if not set) and timestamp
        await db
          .update(mediaItems)
          .set({ ...artworkUpdate, updated_at: now })
          .where(eq(mediaItems.id, mediaItemId))
      } else {
        // Not yet enriched — update artwork and file-derived fields
        await db
          .update(mediaItems)
          .set({
            ...artworkUpdate,
            updated_at: now,
          })
          .where(eq(mediaItems.id, mediaItemId))
      }
    } else {
      mediaItemId = crypto.randomUUID()
      await db.insert(mediaItems).values({
        id: mediaItemId,
        library_id: library.id,
        parent_id: null,
        kind,
        title,
        sort_title: title.toLowerCase().replace(/^(the|a|an)\s+/i, ''),
        year: year ?? null,
        overview: null,
        poster_path: artwork.posterPath,
        backdrop_path: artwork.backdropPath,
        original_title: null,
        release_date: null,
        content_rating: null,
        runtime_seconds: null,
        season_number: null,
        episode_number: null,
        episode_title: null,
        absolute_episode_number: null,
        metadata_status: 'local',
        metadata_source: 'filename',
        metadata_updated_at: nowMs,
        external_tmdb_id: null,
        external_tvdb_id: null,
        external_musicbrainz_id: null,
        created_at: now,
        updated_at: now,
      })
    }

    // Create media version
    const mediaVersionId = crypto.randomUUID()
    await db.insert(mediaVersions).values({
      id: mediaVersionId,
      media_item_id: mediaItemId,
      label: null,
      quality_label: qualityLabel,
      resolution_width: resolutionWidth,
      resolution_height: resolutionHeight,
      video_codec: videoCodec,
      audio_codec: audioCodec,
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
      missing_at: null,
      discovered_at: now,
      updated_at: now,
    })

    counts.added++
  }

  logger.info({ libraryId: library.id, ...counts }, 'Scan complete')
  return counts
}
