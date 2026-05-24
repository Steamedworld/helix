import { existsSync } from 'fs'
import { eq } from 'drizzle-orm'
import type { DrizzleDB } from '../../db/client'
import { mediaFiles, mediaVersions, nodes } from '../../db/schema'

export interface PlaybackSource {
  nodeId: string
  nodeBaseUrl: string | null
  fileId: string
  filePath: string
  versionId: string
  filename: string
  container: string | null
  quality_label: string | null
  resolution_width: number | null
  resolution_height: number | null
  video_codec: string | null
  audio_codec: string | null
  streamUrl: string
  score: number  // lower = preferred
}

export interface PlaybackSourceResult {
  source: PlaybackSource
  unavailable?: never
}

export interface PlaybackSourceUnavailable {
  source?: never
  unavailable: true
  reason: string
}

export type PlaybackSourceOrUnavailable = PlaybackSourceResult | PlaybackSourceUnavailable

// Resolution scoring: prefer higher resolution
function resolutionScore(width: number | null, height: number | null): number {
  if (!width || !height) return 1000  // unknown → deprioritize slightly
  const px = width * height
  // Invert so higher resolution = lower score
  if (px >= 3840 * 2160) return 10  // 4K
  if (px >= 1920 * 1080) return 20  // 1080p
  if (px >= 1280 * 720) return 30   // 720p
  if (px >= 854 * 480) return 40    // 480p
  return 50
}

export async function selectBestSource(
  mediaItemId: string,
  _userId: string,
  db?: DrizzleDB,
  localNodeId?: string,
  baseUrl?: string | null
): Promise<PlaybackSource | null> {
  // Legacy stub call (no db) — federation not implemented
  if (!db || !localNodeId) return null

  return selectBestLocalSource(mediaItemId, db, localNodeId, baseUrl ?? null)
}

export async function selectBestLocalSource(
  mediaItemId: string,
  db: DrizzleDB,
  localNodeId: string,
  baseUrl: string | null
): Promise<PlaybackSource | null> {
  // Get all files for this media item on the local node, joined with version info
  const rows = await db
    .select({
      file: mediaFiles,
      version: mediaVersions,
    })
    .from(mediaFiles)
    .innerJoin(mediaVersions, eq(mediaFiles.media_version_id, mediaVersions.id))
    .where(eq(mediaFiles.media_item_id, mediaItemId))

  if (rows.length === 0) return null

  // Filter to local node only, and files that exist on disk
  const localRows = rows.filter(
    (r) => r.file.node_id === localNodeId && existsSync(r.file.path)
  )

  if (localRows.length === 0) return null

  // Score each candidate: prefer higher resolution
  const scored = localRows.map((r) => ({
    ...r,
    score: resolutionScore(r.version.resolution_width, r.version.resolution_height),
  }))

  // Sort ascending (lowest score = best)
  scored.sort((a, b) => a.score - b.score)

  const best = scored[0]
  const nodeBaseUrl = baseUrl ?? 'http://localhost:3001'
  const streamUrl = `${nodeBaseUrl}/api/v1/media-files/${best.file.id}/stream`

  return {
    nodeId: localNodeId,
    nodeBaseUrl: baseUrl,
    fileId: best.file.id,
    filePath: best.file.path,
    versionId: best.version.id,
    filename: best.file.filename,
    container: best.version.container,
    quality_label: best.version.quality_label,
    resolution_width: best.version.resolution_width,
    resolution_height: best.version.resolution_height,
    video_codec: best.version.video_codec,
    audio_codec: best.version.audio_codec,
    streamUrl,
    score: best.score,
  }
}

export async function getPlaybackSource(
  mediaItemId: string,
  db: DrizzleDB,
  localNodeId: string,
  baseUrl: string | null
): Promise<PlaybackSourceOrUnavailable> {
  // Check if media item has any files at all
  const allFiles = await db
    .select({ id: mediaFiles.id, node_id: mediaFiles.node_id, path: mediaFiles.path })
    .from(mediaFiles)
    .where(eq(mediaFiles.media_item_id, mediaItemId))

  if (allFiles.length === 0) {
    return { unavailable: true, reason: 'No files found for this media item' }
  }

  // Check local files
  const localFiles = allFiles.filter((f) => f.node_id === localNodeId)
  if (localFiles.length === 0) {
    return { unavailable: true, reason: 'No files available on the local node' }
  }

  // Check that at least one exists on disk
  const existingFiles = localFiles.filter((f) => existsSync(f.path))
  if (existingFiles.length === 0) {
    return { unavailable: true, reason: 'File(s) found in catalog but not on disk — library may need re-scan' }
  }

  const source = await selectBestLocalSource(mediaItemId, db, localNodeId, baseUrl)
  if (!source) {
    return { unavailable: true, reason: 'Source selection failed unexpectedly' }
  }

  return { source }
}
