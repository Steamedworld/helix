import { promises as fs } from 'fs'
import { join, normalize, resolve, extname } from 'path'
import { logger } from '../../lib/logger'
import type { DrizzleDB } from '../../db/client'
import { mediaItems } from '../../db/schema'
import { eq } from 'drizzle-orm'

// ─── Path safety ────────────────────────────────────────────────────────────────

/**
 * Validates that the resolved target path is strictly within the allowed cacheDir.
 * Prevents path traversal attacks.
 */
export function isPathSafeWithinCache(targetPath: string, cacheDir: string): boolean {
  const resolvedTarget = resolve(normalize(targetPath))
  const resolvedCache = resolve(normalize(cacheDir))
  return resolvedTarget.startsWith(resolvedCache + '/') || resolvedTarget.startsWith(resolvedCache + '\\')
}

// ─── Extension from content-type or URL ────────────────────────────────────────

function extFromContentType(contentType: string | null): string {
  if (!contentType) return '.jpg'
  if (contentType.includes('png')) return '.png'
  if (contentType.includes('webp')) return '.webp'
  return '.jpg'
}

function extFromUrl(url: string): string {
  const path = url.split('?')[0]
  const ext = extname(path).toLowerCase()
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg'
}

// ─── Cache artwork ──────────────────────────────────────────────────────────────

/**
 * Downloads a remote image and saves it to {cacheDir}/{mediaItemId}/{kind}.{ext}.
 * Returns the local file path on success, or null on failure.
 *
 * Rules:
 * - If the DB already has a non-null value for poster_path/backdrop_path, local wins — skip download.
 * - Updates DB with the cached path on success.
 * - Validates that the target path is within cacheDir (traversal prevention).
 */
export async function cacheArtwork(
  db: DrizzleDB,
  mediaItemId: string,
  kind: 'poster' | 'backdrop',
  remoteUrl: string,
  cacheDir: string
): Promise<string | null> {
  // Load current DB state to check local-wins rule
  const [item] = await db
    .select({ poster_path: mediaItems.poster_path, backdrop_path: mediaItems.backdrop_path })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId))

  if (!item) return null

  const existingPath = kind === 'poster' ? item.poster_path : item.backdrop_path
  if (existingPath) {
    // Local artwork wins — do not overwrite
    logger.debug({ mediaItemId, kind }, 'Local artwork exists, skipping remote download')
    return existingPath
  }

  // Determine extension from URL (we'll update if Content-Type says otherwise)
  const urlExt = extFromUrl(remoteUrl)
  const itemCacheDir = join(cacheDir, mediaItemId)
  const targetPath = join(itemCacheDir, `${kind}${urlExt}`)

  // Traversal prevention
  if (!isPathSafeWithinCache(targetPath, cacheDir)) {
    logger.warn({ targetPath, cacheDir }, 'Artwork cache path traversal attempt rejected')
    return null
  }

  // Download
  let buffer: Buffer
  let finalExt = urlExt
  try {
    const response = await fetch(remoteUrl)
    if (!response.ok) {
      logger.warn({ status: response.status, url: remoteUrl }, 'Artwork download failed')
      return null
    }
    const contentType = response.headers.get('Content-Type')
    finalExt = extFromContentType(contentType)

    const arrayBuffer = await response.arrayBuffer()
    buffer = Buffer.from(new Uint8Array(arrayBuffer))
  } catch (e) {
    logger.warn({ err: e, url: remoteUrl }, 'Artwork download error')
    return null
  }

  // Final path with correct extension
  const finalPath = join(itemCacheDir, `${kind}${finalExt}`)

  // Traversal check again with final path
  if (!isPathSafeWithinCache(finalPath, cacheDir)) {
    logger.warn({ finalPath, cacheDir }, 'Artwork final path traversal attempt rejected')
    return null
  }

  // Write to disk
  try {
    await fs.mkdir(itemCacheDir, { recursive: true })
    await fs.writeFile(finalPath, buffer)
  } catch (e) {
    logger.warn({ err: e, path: finalPath }, 'Failed to write cached artwork')
    return null
  }

  // Update DB
  const field = kind === 'poster' ? { poster_path: finalPath } : { backdrop_path: finalPath }
  await db
    .update(mediaItems)
    .set({ ...field, updated_at: new Date().toISOString() })
    .where(eq(mediaItems.id, mediaItemId))

  logger.info({ mediaItemId, kind, path: finalPath }, 'Artwork cached')
  return finalPath
}
