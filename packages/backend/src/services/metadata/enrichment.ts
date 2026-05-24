import type { DrizzleDB } from '../../db/client'
import { mediaItems } from '../../db/schema'
import { eq, or, inArray } from 'drizzle-orm'
import { metadataRegistry } from './registry'
import { scoreCandidate, MATCH_THRESHOLD } from './scoring'
import { cacheArtwork } from './artworkCache'
import { config } from '../../config'
import { logger } from '../../lib/logger'
import type { MetadataCandidate, EnrichedMovieMetadata, MetadataProvider } from './types'

// ─── Result types ───────────────────────────────────────────────────────────────

export type EnrichmentStatus =
  | 'matched'
  | 'needs_review'
  | 'no_provider'
  | 'skipped'
  | 'error'
  | 'parent_unmatched'

export interface EnrichmentResult {
  mediaItemId: string
  status: EnrichmentStatus
  candidate?: MetadataCandidate
  details?: EnrichedMovieMetadata
  error?: string
  message?: string
}

// ─── Shared search helper ────────────────────────────────────────────────────────

async function searchBestCandidate(
  title: string,
  year: number | null,
  searchFn: (provider: MetadataProvider, title: string, year?: number) => Promise<MetadataCandidate[]>,
  providers: MetadataProvider[],
  itemId: string,
): Promise<{ bestCandidate: MetadataCandidate | null; bestScore: number }> {
  const query = { title, year: year ?? undefined }
  let bestCandidate: MetadataCandidate | null = null
  let bestScore = -1

  for (const provider of providers) {
    try {
      const rawCandidates = await searchFn(provider, title, year ?? undefined)
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

  return { bestCandidate, bestScore }
}

// ─── Enrich movie ────────────────────────────────────────────────────────────────

async function enrichMovie(
  db: DrizzleDB,
  itemId: string,
  options?: { force?: boolean },
): Promise<EnrichmentResult> {
  const [item] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, itemId))

  if (!item) {
    return { mediaItemId: itemId, status: 'error', error: 'Media item not found' }
  }

  if ((item.metadata_status === 'matched' || item.metadata_status === 'needs_review') && !options?.force) {
    return { mediaItemId: itemId, status: 'skipped' }
  }

  const providers = metadataRegistry.getEnabledProvidersForKind('movie')
  if (providers.length === 0) {
    return { mediaItemId: itemId, status: 'no_provider' }
  }

  const { bestCandidate, bestScore } = await searchBestCandidate(
    item.title,
    item.year,
    (p, title, year) => p.searchMovies(title, year),
    providers,
    itemId,
  )

  if (!bestCandidate || bestScore < 0) {
    await db
      .update(mediaItems)
      .set({ metadata_status: 'needs_review', updated_at: new Date().toISOString() })
      .where(eq(mediaItems.id, itemId))
    return { mediaItemId: itemId, status: 'needs_review' }
  }

  if (bestScore < MATCH_THRESHOLD) {
    await db
      .update(mediaItems)
      .set({ metadata_status: 'needs_review', updated_at: new Date().toISOString() })
      .where(eq(mediaItems.id, itemId))
    return { mediaItemId: itemId, status: 'needs_review', candidate: bestCandidate }
  }

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

// ─── Enrich show ─────────────────────────────────────────────────────────────────

export async function enrichShow(
  db: DrizzleDB,
  showItemId: string,
  options?: { force?: boolean },
): Promise<EnrichmentResult> {
  const [item] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, showItemId))

  if (!item) {
    return { mediaItemId: showItemId, status: 'error', error: 'Media item not found' }
  }

  if ((item.metadata_status === 'matched' || item.metadata_status === 'needs_review') && !options?.force) {
    return { mediaItemId: showItemId, status: 'skipped' }
  }

  const providers = metadataRegistry.getEnabledProvidersForKind('show')
    .filter((p) => typeof p.searchShows === 'function')

  if (providers.length === 0) {
    return { mediaItemId: showItemId, status: 'no_provider' }
  }

  const { bestCandidate, bestScore } = await searchBestCandidate(
    item.title,
    item.year,
    (p, title, year) => p.searchShows!(title, year),
    providers,
    showItemId,
  )

  if (!bestCandidate || bestScore < 0) {
    await db
      .update(mediaItems)
      .set({ metadata_status: 'needs_review', updated_at: new Date().toISOString() })
      .where(eq(mediaItems.id, showItemId))
    return { mediaItemId: showItemId, status: 'needs_review' }
  }

  if (bestScore < MATCH_THRESHOLD) {
    await db
      .update(mediaItems)
      .set({ metadata_status: 'needs_review', updated_at: new Date().toISOString() })
      .where(eq(mediaItems.id, showItemId))
    return { mediaItemId: showItemId, status: 'needs_review', candidate: bestCandidate }
  }

  const provider = metadataRegistry.getProvider(bestCandidate.providerId)
  if (!provider || !provider.getShowDetails) {
    return { mediaItemId: showItemId, status: 'error', error: 'Provider does not support getShowDetails' }
  }

  let showDetails = null
  try {
    showDetails = await provider.getShowDetails(bestCandidate.externalId)
  } catch (e) {
    logger.warn({ err: e, showItemId, externalId: bestCandidate.externalId }, 'getShowDetails failed')
  }

  if (!showDetails) {
    await db
      .update(mediaItems)
      .set({ metadata_status: 'needs_review', updated_at: new Date().toISOString() })
      .where(eq(mediaItems.id, showItemId))
    return { mediaItemId: showItemId, status: 'needs_review', candidate: bestCandidate }
  }

  const now = new Date().toISOString()
  const nowMs = Date.now()

  const airYear = showDetails.firstAirDate
    ? parseInt(showDetails.firstAirDate.slice(0, 4), 10) || null
    : null

  const externalIdUpdate = bestCandidate.providerId === 'tmdb'
    ? { external_tmdb_id: bestCandidate.externalId }
    : {}

  await db
    .update(mediaItems)
    .set({
      title: showDetails.title ?? item.title,
      original_title: showDetails.originalTitle ?? null,
      overview: showDetails.overview ?? null,
      release_date: showDetails.firstAirDate ?? null,
      year: airYear ?? item.year,
      content_rating: showDetails.contentRating ?? null,
      metadata_status: 'matched',
      metadata_source: bestCandidate.providerId,
      metadata_updated_at: nowMs,
      ...externalIdUpdate,
      updated_at: now,
    })
    .where(eq(mediaItems.id, showItemId))

  // Cache show artwork
  if (showDetails.posterUrl) {
    await cacheArtwork(db, showItemId, 'poster', showDetails.posterUrl, config.metadataCacheDir)
      .catch((e) => logger.warn({ err: e }, 'Show poster cache failed'))
  }
  if (showDetails.backdropUrl) {
    await cacheArtwork(db, showItemId, 'backdrop', showDetails.backdropUrl, config.metadataCacheDir)
      .catch((e) => logger.warn({ err: e }, 'Show backdrop cache failed'))
  }

  // Enrich child seasons
  const seasonItems = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.parent_id, showItemId))

  for (const season of seasonItems) {
    if (season.kind === 'season' && season.season_number !== null) {
      await enrichSeason(db, season.id, {
        externalShowId: bestCandidate.externalId,
        providerId: bestCandidate.providerId,
      }).catch((e) => logger.warn({ err: e, seasonId: season.id }, 'Season enrichment failed'))
    }
  }

  return { mediaItemId: showItemId, status: 'matched', candidate: bestCandidate }
}

// ─── Enrich season ───────────────────────────────────────────────────────────────

export async function enrichSeason(
  db: DrizzleDB,
  seasonItemId: string,
  context: { externalShowId: string; providerId: string },
): Promise<EnrichmentResult> {
  const [season] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, seasonItemId))

  if (!season || season.kind !== 'season' || season.season_number === null) {
    return { mediaItemId: seasonItemId, status: 'error', error: 'Season item not found or invalid' }
  }

  const provider = metadataRegistry.getProvider(context.providerId)
  if (!provider || !provider.getSeasonDetails) {
    return { mediaItemId: seasonItemId, status: 'no_provider' }
  }

  let seasonDetails = null
  try {
    seasonDetails = await provider.getSeasonDetails(context.externalShowId, season.season_number)
  } catch (e) {
    logger.warn({ err: e, seasonItemId }, 'getSeasonDetails failed')
    return { mediaItemId: seasonItemId, status: 'error', error: String(e) }
  }

  if (!seasonDetails) {
    return { mediaItemId: seasonItemId, status: 'needs_review' }
  }

  const now = new Date().toISOString()
  const nowMs = Date.now()

  const airYear = seasonDetails.airDate
    ? parseInt(seasonDetails.airDate.slice(0, 4), 10) || null
    : null

  await db
    .update(mediaItems)
    .set({
      overview: seasonDetails.overview ?? null,
      release_date: seasonDetails.airDate ?? null,
      year: airYear ?? season.year,
      metadata_status: 'matched',
      metadata_source: context.providerId,
      metadata_updated_at: nowMs,
      updated_at: now,
    })
    .where(eq(mediaItems.id, seasonItemId))

  if (seasonDetails.posterUrl) {
    await cacheArtwork(db, seasonItemId, 'poster', seasonDetails.posterUrl, config.metadataCacheDir)
      .catch((e) => logger.warn({ err: e }, 'Season poster cache failed'))
  }

  return { mediaItemId: seasonItemId, status: 'matched' }
}

// ─── Enrich episode ──────────────────────────────────────────────────────────────

export async function enrichEpisode(
  db: DrizzleDB,
  episodeItemId: string,
  options?: { force?: boolean },
): Promise<EnrichmentResult> {
  const [episode] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, episodeItemId))

  if (!episode || episode.kind !== 'episode') {
    return { mediaItemId: episodeItemId, status: 'error', error: 'Episode item not found or invalid' }
  }

  if ((episode.metadata_status === 'matched' || episode.metadata_status === 'needs_review') && !options?.force) {
    return { mediaItemId: episodeItemId, status: 'skipped' }
  }

  if (!episode.parent_id) {
    return { mediaItemId: episodeItemId, status: 'error', error: 'Episode has no parent season' }
  }

  // Load parent season
  const [season] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, episode.parent_id))

  if (!season || season.kind !== 'season') {
    return { mediaItemId: episodeItemId, status: 'error', error: 'Parent season not found' }
  }

  if (!season.parent_id) {
    return { mediaItemId: episodeItemId, status: 'error', error: 'Season has no parent show' }
  }

  // Load grandparent show
  const [show] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, season.parent_id))

  if (!show || show.kind !== 'show') {
    return { mediaItemId: episodeItemId, status: 'error', error: 'Parent show not found' }
  }

  if (show.metadata_status !== 'matched') {
    return {
      mediaItemId: episodeItemId,
      status: 'parent_unmatched',
      message: 'Match the parent show first to enable episode enrichment',
    }
  }

  if (!show.external_tmdb_id) {
    return { mediaItemId: episodeItemId, status: 'error', error: 'Parent show has no external ID' }
  }

  const provider = metadataRegistry.getProvider(show.metadata_source ?? '')
  if (!provider || !provider.getEpisodeDetails) {
    // Fallback: try any provider that supports episodes
    const providers = metadataRegistry.getEnabledProvidersForKind('episode')
      .filter((p) => typeof p.getEpisodeDetails === 'function')
    if (providers.length === 0) {
      return { mediaItemId: episodeItemId, status: 'no_provider' }
    }
  }

  // Use the show's provider
  const episodeProvider = metadataRegistry.getProvider(show.metadata_source ?? '')
  if (!episodeProvider || !episodeProvider.getEpisodeDetails) {
    return { mediaItemId: episodeItemId, status: 'no_provider' }
  }

  const seasonNumber = season.season_number
  const episodeNumber = episode.episode_number

  if (seasonNumber === null || episodeNumber === null) {
    return { mediaItemId: episodeItemId, status: 'error', error: 'Season or episode number missing' }
  }

  let episodeDetails = null
  try {
    episodeDetails = await episodeProvider.getEpisodeDetails(show.external_tmdb_id, seasonNumber, episodeNumber)
  } catch (e) {
    logger.warn({ err: e, episodeItemId }, 'getEpisodeDetails failed')
    return { mediaItemId: episodeItemId, status: 'error', error: String(e) }
  }

  if (!episodeDetails) {
    return { mediaItemId: episodeItemId, status: 'needs_review' }
  }

  const now = new Date().toISOString()
  const nowMs = Date.now()

  const airYear = episodeDetails.airDate
    ? parseInt(episodeDetails.airDate.slice(0, 4), 10) || null
    : null

  await db
    .update(mediaItems)
    .set({
      episode_title: episodeDetails.title ?? null,
      overview: episodeDetails.overview ?? null,
      release_date: episodeDetails.airDate ?? null,
      year: airYear ?? episode.year,
      runtime_seconds: episodeDetails.runtimeMinutes ? episodeDetails.runtimeMinutes * 60 : null,
      absolute_episode_number: episodeDetails.absoluteEpisodeNumber ?? null,
      metadata_status: 'matched',
      metadata_source: show.metadata_source,
      metadata_updated_at: nowMs,
      updated_at: now,
    })
    .where(eq(mediaItems.id, episodeItemId))

  // Cache episode still image using poster_path slot (episodes don't have traditional posters).
  // The artwork endpoint already serves poster_path for kind=poster, so episode stills
  // are accessible via /api/v1/media/:id/artwork/poster — no schema change required.
  if (episodeDetails.stillUrl) {
    await cacheArtwork(db, episodeItemId, 'poster', episodeDetails.stillUrl, config.metadataCacheDir)
      .catch((e) => logger.warn({ err: e }, 'Episode still cache failed'))
  }

  return { mediaItemId: episodeItemId, status: 'matched' }
}

// ─── Enrich single item (dispatch by kind) ──────────────────────────────────────

export async function enrichMediaItem(
  db: DrizzleDB,
  itemId: string,
  options?: { force?: boolean }
): Promise<EnrichmentResult> {
  const [item] = await db
    .select({ id: mediaItems.id, kind: mediaItems.kind })
    .from(mediaItems)
    .where(eq(mediaItems.id, itemId))

  if (!item) {
    return { mediaItemId: itemId, status: 'error', error: 'Media item not found' }
  }

  switch (item.kind) {
    case 'movie':
      return enrichMovie(db, itemId, options)
    case 'show':
      return enrichShow(db, itemId, options)
    case 'episode':
      return enrichEpisode(db, itemId, options)
    case 'season':
      return {
        mediaItemId: itemId,
        status: 'skipped',
        message: 'Enrich the parent show instead — season data is fetched automatically',
      }
    default: {
      // For other kinds (track, album, photo, other): check if any provider supports them
      const providers = metadataRegistry.getEnabledProvidersForKind(item.kind as any)
      if (providers.length === 0) {
        return { mediaItemId: itemId, status: 'no_provider' }
      }
      // Fall back to movie path for unknown enrichable kinds
      return enrichMovie(db, itemId, options)
    }
  }
}

// ─── Batch enrich ───────────────────────────────────────────────────────────────

export async function enrichBatch(
  db: DrizzleDB,
  limit = 20
): Promise<EnrichmentResult[]> {
  // Fetch unenriched items — process shows before episodes so parent is matched first
  const unenrichedItems = await db
    .select({ id: mediaItems.id, kind: mediaItems.kind })
    .from(mediaItems)
    .where(
      or(
        eq(mediaItems.metadata_status, 'unknown'),
        eq(mediaItems.metadata_status, 'local')
      )
    )
    .limit(limit * 2) // over-fetch so we can sort and take limit

  // Sort: shows first, then movies, then episodes, then rest
  const priority: Record<string, number> = { show: 0, movie: 1, episode: 2 }
  const sorted = [...unenrichedItems].sort(
    (a, b) => (priority[a.kind] ?? 3) - (priority[b.kind] ?? 3)
  )

  const toProcess = sorted.slice(0, limit)

  const results: EnrichmentResult[] = []
  for (const item of toProcess) {
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

  const now = new Date().toISOString()
  const nowMs = Date.now()

  // ─── Show match ─────────────────────────────────────────────────────────────
  if (item.kind === 'show') {
    if (!provider.getShowDetails) {
      return { mediaItemId: itemId, status: 'error', error: 'Provider does not support TV shows' }
    }
    let showDetails = null
    try {
      showDetails = await provider.getShowDetails(externalId)
    } catch (e) {
      return { mediaItemId: itemId, status: 'error', error: String(e) }
    }
    if (!showDetails) {
      return { mediaItemId: itemId, status: 'error', error: 'Show not found in provider' }
    }

    const airYear = showDetails.firstAirDate
      ? parseInt(showDetails.firstAirDate.slice(0, 4), 10) || null
      : null

    const externalIdUpdate = providerId === 'tmdb' ? { external_tmdb_id: externalId } : {}

    await db
      .update(mediaItems)
      .set({
        title: showDetails.title ?? item.title,
        original_title: showDetails.originalTitle ?? null,
        overview: showDetails.overview ?? null,
        release_date: showDetails.firstAirDate ?? null,
        year: airYear ?? item.year,
        content_rating: showDetails.contentRating ?? null,
        metadata_status: 'matched',
        metadata_source: providerId,
        metadata_updated_at: nowMs,
        ...externalIdUpdate,
        updated_at: now,
      })
      .where(eq(mediaItems.id, itemId))

    if (showDetails.posterUrl) {
      await cacheArtwork(db, itemId, 'poster', showDetails.posterUrl, config.metadataCacheDir)
        .catch((e) => logger.warn({ err: e }, 'Show poster cache failed'))
    }
    if (showDetails.backdropUrl) {
      await cacheArtwork(db, itemId, 'backdrop', showDetails.backdropUrl, config.metadataCacheDir)
        .catch((e) => logger.warn({ err: e }, 'Show backdrop cache failed'))
    }

    // Enrich child seasons
    const seasonItems = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.parent_id, itemId))

    for (const season of seasonItems) {
      if (season.kind === 'season' && season.season_number !== null) {
        await enrichSeason(db, season.id, { externalShowId: externalId, providerId })
          .catch((e) => logger.warn({ err: e, seasonId: season.id }, 'Season enrichment during match failed'))
      }
    }

    return { mediaItemId: itemId, status: 'matched' }
  }

  // ─── Movie match (default) ──────────────────────────────────────────────────
  let details: EnrichedMovieMetadata | null = null
  try {
    details = await provider.getMovieDetails(externalId)
  } catch (e) {
    return { mediaItemId: itemId, status: 'error', error: String(e) }
  }

  if (!details) {
    return { mediaItemId: itemId, status: 'error', error: 'Item not found in provider' }
  }

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
