import type { DrizzleDB } from '../../db/client'
import { mediaItems } from '../../db/schema'
import { eq, or } from 'drizzle-orm'
import { metadataRegistry } from './registry'
import { scoreCandidate, MATCH_THRESHOLD } from './scoring'
import { cacheArtwork } from './artworkCache'
import { config } from '../../config'
import { logger } from '../../lib/logger'
import type { MetadataCandidate, EnrichedMovieMetadata } from './types'

// ─── Result types ───────────────────────────────────────────────────────────────

export type EnrichmentStatus =
  | 'matched'
  | 'needs_review'
  | 'no_provider'
  | 'skipped'
  | 'error'

export interface EnrichmentResult {
  mediaItemId: string
  status: EnrichmentStatus
  candidate?: MetadataCandidate
  details?: EnrichedMovieMetadata
  error?: string
}

// ─── Enrich single item ─────────────────────────────────────────────────────────

export async function enrichMediaItem(
  db: DrizzleDB,
  itemId: string,
  options?: { force?: boolean }
): Promise<EnrichmentResult> {
  const [item] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, itemId))

  if (!item) {
    return { mediaItemId: itemId, status: 'error', error: 'Media item not found' }
  }

  // Skip already-matched items unless force=true
  if ((item.metadata_status === 'matched' || item.metadata_status === 'needs_review') && !options?.force) {
    return { mediaItemId: itemId, status: 'skipped' }
  }

  // Get configured providers for this kind
  const providers = metadataRegistry.getEnabledProvidersForKind(item.kind as any)
  if (providers.length === 0) {
    return { mediaItemId: itemId, status: 'no_provider' }
  }

  const query = { title: item.title, year: item.year ?? undefined }
  let bestCandidate: MetadataCandidate | null = null
  let bestScore = -1

  // Search all providers and collect candidates
  for (const provider of providers) {
    try {
      const rawCandidates = await provider.searchMovies(item.title, item.year ?? undefined)

      for (const candidate of rawCandidates) {
        const score = scoreCandidate(candidate, query)
        if (score > bestScore) {
          bestScore = score
          bestCandidate = { ...candidate, score }
        }
      }
    } catch (e) {
      logger.warn({ err: e, providerId: provider.id, itemId }, 'Provider search failed')
    }
  }

  if (!bestCandidate || bestScore < 0) {
    // No results at all
    await db
      .update(mediaItems)
      .set({ metadata_status: 'needs_review', updated_at: new Date().toISOString() })
      .where(eq(mediaItems.id, itemId))
    return { mediaItemId: itemId, status: 'needs_review' }
  }

  if (bestScore < MATCH_THRESHOLD) {
    // Low confidence
    await db
      .update(mediaItems)
      .set({ metadata_status: 'needs_review', updated_at: new Date().toISOString() })
      .where(eq(mediaItems.id, itemId))
    return { mediaItemId: itemId, status: 'needs_review', candidate: bestCandidate }
  }

  // High confidence — fetch full details
  const provider = metadataRegistry.getProvider(bestCandidate.providerId)
  if (!provider) {
    return { mediaItemId: itemId, status: 'error', error: 'Provider disappeared from registry' }
  }

  let details: EnrichedMovieMetadata | null = null
  try {
    details = await provider.getMovieDetails(bestCandidate.externalId)
  } catch (e) {
    logger.warn({ err: e, itemId, externalId: bestCandidate.externalId }, 'getMovieDetails failed')
  }

  if (!details) {
    // Couldn't fetch full details — still mark needs_review
    await db
      .update(mediaItems)
      .set({ metadata_status: 'needs_review', updated_at: new Date().toISOString() })
      .where(eq(mediaItems.id, itemId))
    return { mediaItemId: itemId, status: 'needs_review', candidate: bestCandidate }
  }

  const now = new Date().toISOString()
  const nowMs = Date.now()

  const releaseYear = details.releaseDate
    ? parseInt(details.releaseDate.slice(0, 4), 10) || null
    : null

  // Build the external ID field update
  const externalIdUpdate = bestCandidate.providerId === 'tmdb'
    ? { external_tmdb_id: bestCandidate.externalId }
    : {}

  await db
    .update(mediaItems)
    .set({
      title: details.title ?? item.title,
      original_title: details.originalTitle ?? null,
      overview: details.overview ?? null,
      release_date: details.releaseDate ?? null,
      year: releaseYear ?? item.year,
      content_rating: details.contentRating ?? null,
      runtime_seconds: details.runtimeMinutes ? details.runtimeMinutes * 60 : null,
      metadata_status: 'matched',
      metadata_source: bestCandidate.providerId,
      metadata_updated_at: nowMs,
      ...externalIdUpdate,
      updated_at: now,
    })
    .where(eq(mediaItems.id, itemId))

  // Cache artwork (local wins rule is enforced inside cacheArtwork)
  if (details.posterUrl) {
    await cacheArtwork(db, itemId, 'poster', details.posterUrl, config.metadataCacheDir)
      .catch((e) => logger.warn({ err: e }, 'Poster cache failed'))
  }
  if (details.backdropUrl) {
    await cacheArtwork(db, itemId, 'backdrop', details.backdropUrl, config.metadataCacheDir)
      .catch((e) => logger.warn({ err: e }, 'Backdrop cache failed'))
  }

  return { mediaItemId: itemId, status: 'matched', candidate: bestCandidate, details }
}

// ─── Batch enrich ───────────────────────────────────────────────────────────────

export async function enrichBatch(
  db: DrizzleDB,
  limit = 20
): Promise<EnrichmentResult[]> {
  // Find items that are not yet matched (unknown or local status)
  const items = await db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(
      or(
        eq(mediaItems.metadata_status, 'unknown'),
        eq(mediaItems.metadata_status, 'local')
      )
    )
    .limit(limit)

  const results: EnrichmentResult[] = []
  for (const item of items) {
    const result = await enrichMediaItem(db, item.id)
    results.push(result)
  }

  return results
}

// ─── Apply match from specific candidate ────────────────────────────────────────

export async function applyMatch(
  db: DrizzleDB,
  itemId: string,
  providerId: string,
  externalId: string,
): Promise<EnrichmentResult> {
  const [item] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, itemId))

  if (!item) {
    return { mediaItemId: itemId, status: 'error', error: 'Media item not found' }
  }

  const provider = metadataRegistry.getProvider(providerId)
  if (!provider) {
    return { mediaItemId: itemId, status: 'error', error: `Unknown provider: ${providerId}` }
  }

  if (!provider.isConfigured()) {
    return { mediaItemId: itemId, status: 'no_provider' }
  }

  let details: EnrichedMovieMetadata | null = null
  try {
    details = await provider.getMovieDetails(externalId)
  } catch (e) {
    return { mediaItemId: itemId, status: 'error', error: String(e) }
  }

  if (!details) {
    return { mediaItemId: itemId, status: 'error', error: 'Item not found in provider' }
  }

  const now = new Date().toISOString()
  const nowMs = Date.now()

  const releaseYear = details.releaseDate
    ? parseInt(details.releaseDate.slice(0, 4), 10) || null
    : null

  const externalIdUpdate = providerId === 'tmdb'
    ? { external_tmdb_id: externalId }
    : {}

  await db
    .update(mediaItems)
    .set({
      title: details.title ?? item.title,
      original_title: details.originalTitle ?? null,
      overview: details.overview ?? null,
      release_date: details.releaseDate ?? null,
      year: releaseYear ?? item.year,
      content_rating: details.contentRating ?? null,
      runtime_seconds: details.runtimeMinutes ? details.runtimeMinutes * 60 : null,
      metadata_status: 'matched',
      metadata_source: providerId,
      metadata_updated_at: nowMs,
      ...externalIdUpdate,
      updated_at: now,
    })
    .where(eq(mediaItems.id, itemId))

  if (details.posterUrl) {
    await cacheArtwork(db, itemId, 'poster', details.posterUrl, config.metadataCacheDir)
      .catch((e) => logger.warn({ err: e }, 'Poster cache failed'))
  }
  if (details.backdropUrl) {
    await cacheArtwork(db, itemId, 'backdrop', details.backdropUrl, config.metadataCacheDir)
      .catch((e) => logger.warn({ err: e }, 'Backdrop cache failed'))
  }

  return { mediaItemId: itemId, status: 'matched', details }
}
