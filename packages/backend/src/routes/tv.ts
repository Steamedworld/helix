import type { FastifyInstance } from 'fastify'
import { eq, and, sql, count, isNull, inArray } from 'drizzle-orm'
import { mediaItems, mediaFiles, watchStates, externalMediaLinks, integrations } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import {
  getUpNextEpisode,
  getNextEpisode,
  getShowProgress,
  getOrderedEpisodes,
} from '../services/episodeOrder'
import { makeRequireAuth } from '../middleware/auth'
import { canViewLibrary, getViewableLibraryIds } from '../lib/permissions'
import { signArtworkToken } from '../lib/signedTokens'

// ─── Response Types ────────────────────────────────────────────────────────────

export interface ShowListItem {
  id: string
  title: string
  year: number | null
  posterUrl: string | null
  backdropUrl: string | null
  episodeCount: number
  overview: string | null
  metadataStatus: string
}

export interface SeasonSummary {
  id: string
  seasonNumber: number
  episodeCount: number
  posterUrl: string | null
  overview: string | null
}

export interface IntegrationLinkSummary {
  kind: string
  integrationName: string
  monitored: boolean
  qualityProfile: string | null
  externalTitle: string | null
}

export interface ShowDetail {
  id: string
  title: string
  year: number | null
  posterUrl: string | null
  backdropUrl: string | null
  overview: string | null
  contentRating: string | null
  metadataStatus: string
  seasons: SeasonSummary[]
  integrationLinks: IntegrationLinkSummary[]
}

export interface EpisodeListItem {
  id: string
  episodeNumber: number
  seasonNumber: number
  title: string
  episodeTitle: string | null
  overview: string | null
  runtime: number | null
  posterUrl: string | null
  /** True if at least one media_file for this episode has missing_at IS NULL */
  hasPlayableFile: boolean
  watchState?: {
    position_seconds: number
    duration_seconds: number | null
    completed: boolean
  } | null
}

export interface EpisodeDetail extends EpisodeListItem {
  showId: string
  showTitle: string
  seasonId: string
  metadataStatus: string
  showMetadataStatus: string
  airDate: string | null
  playbackSource?: unknown
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function artworkUrl(
  mediaItemId: string,
  kind: 'poster' | 'backdrop',
  hasPath: boolean,
  baseUrl: string | null | undefined,
  userId?: string
): string | null {
  if (!hasPath) return null
  const base = baseUrl ?? ''
  const path = `${base}/api/v1/media/${mediaItemId}/artwork/${kind}`
  if (!userId) return path
  const token = signArtworkToken(mediaItemId, kind, userId)
  return `${path}?token=${token}`
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function tvRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId?: string; baseUrl?: string | null }
) {
  const { db, baseUrl } = opts
  const requireAuth = makeRequireAuth(db)

  // GET /api/v1/shows — list all accessible shows
  app.get<{ Querystring: { library_id?: string } }>('/', { preHandler: requireAuth }, async (req) => {
    const user = req.user!
    const { library_id } = req.query

    const viewableIds = user.role === 'admin' ? null : await getViewableLibraryIds(user, db)
    if (viewableIds !== null && viewableIds.length === 0) return ok([])

    const conditions: ReturnType<typeof eq>[] = [eq(mediaItems.kind, 'show') as any]

    if (library_id) {
      if (viewableIds !== null && !viewableIds.includes(library_id)) {
        return ok([])
      }
      conditions.push(eq(mediaItems.library_id, library_id) as any)
    } else if (viewableIds !== null) {
      conditions.push(inArray(mediaItems.library_id, viewableIds) as any)
    }

    const shows = await db
      .select()
      .from(mediaItems)
      .where(and(...(conditions as any[])))
      .orderBy(sql`${mediaItems.sort_title} ASC`)

    const result: ShowListItem[] = await Promise.all(
      shows.map(async (show) => {
        const seasons = await db
          .select({ id: mediaItems.id })
          .from(mediaItems)
          .where(and(eq(mediaItems.parent_id, show.id), eq(mediaItems.kind, 'season')))

        let episodeCount = 0
        for (const season of seasons) {
          const [{ c }] = await db
            .select({ c: count() })
            .from(mediaItems)
            .where(and(eq(mediaItems.parent_id, season.id), eq(mediaItems.kind, 'episode')))
          episodeCount += c
        }

        return {
          id: show.id,
          title: show.title,
          year: show.year,
          posterUrl: artworkUrl(show.id, 'poster', !!show.poster_path, baseUrl, user.id),
          backdropUrl: artworkUrl(show.id, 'backdrop', !!show.backdrop_path, baseUrl, user.id),
          episodeCount,
          overview: show.overview,
          metadataStatus: show.metadata_status,
        }
      })
    )

    return ok(result)
  })

  // GET /api/v1/shows/:id — show detail with seasons
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!

    const [show] = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.id, req.params.id), eq(mediaItems.kind, 'show')))

    if (!show) {
      reply.status(404)
      return err('Show not found')
    }

    if (!await canViewLibrary(user, show.library_id, db)) {
      reply.status(404)
      return err('Show not found')
    }

    const seasons = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.parent_id, show.id), eq(mediaItems.kind, 'season')))
      .orderBy(sql`${mediaItems.season_number} ASC`)

    const seasonSummaries: SeasonSummary[] = await Promise.all(
      seasons.map(async (season) => {
        const [{ c }] = await db
          .select({ c: count() })
          .from(mediaItems)
          .where(and(eq(mediaItems.parent_id, season.id), eq(mediaItems.kind, 'episode')))
        return {
          id: season.id,
          seasonNumber: season.season_number ?? 0,
          episodeCount: c,
          posterUrl: artworkUrl(season.id, 'poster', !!season.poster_path, baseUrl, user.id),
          overview: season.overview,
        }
      })
    )

    const linkRows = await db
      .select({
        kind: integrations.kind,
        name: integrations.name,
        monitored: externalMediaLinks.monitored,
        qualityProfile: externalMediaLinks.quality_profile,
        externalTitle: externalMediaLinks.external_title,
      })
      .from(externalMediaLinks)
      .innerJoin(integrations, eq(externalMediaLinks.integration_id, integrations.id))
      .where(
        and(
          eq(externalMediaLinks.media_item_id, show.id),
          eq(integrations.enabled, 1)
        )
      )

    const integrationLinkSummaries: IntegrationLinkSummary[] = linkRows.map((r) => ({
      kind: r.kind,
      integrationName: r.name,
      monitored: r.monitored === 1,
      qualityProfile: r.qualityProfile,
      externalTitle: r.externalTitle,
    }))

    const detail: ShowDetail = {
      id: show.id,
      title: show.title,
      year: show.year,
      posterUrl: artworkUrl(show.id, 'poster', !!show.poster_path, baseUrl, user.id),
      backdropUrl: artworkUrl(show.id, 'backdrop', !!show.backdrop_path, baseUrl, user.id),
      overview: show.overview,
      contentRating: show.content_rating,
      metadataStatus: show.metadata_status,
      seasons: seasonSummaries,
      integrationLinks: integrationLinkSummaries,
    }

    return ok(detail)
  })

  // GET /api/v1/shows/:id/up-next — up-next episode for a show (requires auth)
  app.get<{ Params: { id: string } }>(
    '/:id/up-next',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.user!

      const [show] = await db
        .select({ id: mediaItems.id, library_id: mediaItems.library_id })
        .from(mediaItems)
        .where(and(eq(mediaItems.id, req.params.id), eq(mediaItems.kind, 'show')))

      if (!show) {
        reply.status(404)
        return err('Show not found')
      }

      if (!await canViewLibrary(user, show.library_id, db)) {
        reply.status(404)
        return err('Show not found')
      }

      const episode = await getUpNextEpisode(db, req.params.id, user.id, baseUrl)

      if (episode === null) {
        const progress = await getShowProgress(db, req.params.id, user.id, baseUrl)
        if (progress.allCompleted && progress.totalEpisodes > 0) {
          const ordered = await getOrderedEpisodes(db, req.params.id, user.id, baseUrl)
          const restartEpisodeId = ordered[0]?.id ?? null
          return ok({ allCompleted: true as const, totalEpisodes: progress.totalEpisodes, restartEpisodeId })
        }
        return ok({ allCompleted: false as const, totalEpisodes: 0 })
      }

      return ok({ episode })
    }
  )

  // GET /api/v1/shows/:id/progress — watch progress summary (requires auth)
  app.get<{ Params: { id: string } }>(
    '/:id/progress',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.user!

      const [show] = await db
        .select({ id: mediaItems.id, library_id: mediaItems.library_id })
        .from(mediaItems)
        .where(and(eq(mediaItems.id, req.params.id), eq(mediaItems.kind, 'show')))

      if (!show) {
        reply.status(404)
        return err('Show not found')
      }

      if (!await canViewLibrary(user, show.library_id, db)) {
        reply.status(404)
        return err('Show not found')
      }

      const progress = await getShowProgress(db, req.params.id, user.id, baseUrl)
      return ok(progress)
    }
  )

  // GET /api/v1/shows/:id/seasons — seasons for a show
  app.get<{ Params: { id: string } }>('/:id/seasons', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!

    const [show] = await db
      .select({ id: mediaItems.id, library_id: mediaItems.library_id })
      .from(mediaItems)
      .where(and(eq(mediaItems.id, req.params.id), eq(mediaItems.kind, 'show')))

    if (!show) {
      reply.status(404)
      return err('Show not found')
    }

    if (!await canViewLibrary(user, show.library_id, db)) {
      reply.status(404)
      return err('Show not found')
    }

    const seasons = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.parent_id, show.id), eq(mediaItems.kind, 'season')))
      .orderBy(sql`${mediaItems.season_number} ASC`)

    const summaries: SeasonSummary[] = await Promise.all(
      seasons.map(async (season) => {
        const [{ c }] = await db
          .select({ c: count() })
          .from(mediaItems)
          .where(and(eq(mediaItems.parent_id, season.id), eq(mediaItems.kind, 'episode')))
        return {
          id: season.id,
          seasonNumber: season.season_number ?? 0,
          episodeCount: c,
          posterUrl: artworkUrl(season.id, 'poster', !!season.poster_path, baseUrl, user.id),
          overview: season.overview,
        }
      })
    )

    return ok(summaries)
  })
}

export async function seasonRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId?: string; baseUrl?: string | null }
) {
  const { db, baseUrl } = opts
  const requireAuth = makeRequireAuth(db)

  // GET /api/v1/seasons/:id/episodes — episodes for a season (with watch state, requires auth)
  app.get<{
    Params: { id: string }
  }>('/:id/episodes', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!

    const [season] = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.id, req.params.id), eq(mediaItems.kind, 'season')))

    if (!season) {
      reply.status(404)
      return err('Season not found')
    }

    if (!await canViewLibrary(user, season.library_id, db)) {
      reply.status(404)
      return err('Season not found')
    }

    const episodes = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.parent_id, season.id), eq(mediaItems.kind, 'episode')))
      .orderBy(sql`${mediaItems.episode_number} ASC`)

    // Fetch watch states for episodes
    const episodeIds = episodes.map((e) => e.id)
    let watchStateMap: Map<string, { position_seconds: number; duration_seconds: number | null; completed: boolean }> = new Map()

    if (episodeIds.length > 0) {
      for (const epId of episodeIds) {
        const [ws] = await db
          .select()
          .from(watchStates)
          .where(and(eq(watchStates.media_item_id, epId), eq(watchStates.user_id, user.id)))
          .limit(1)
        if (ws) {
          watchStateMap.set(epId, {
            position_seconds: ws.position_seconds,
            duration_seconds: ws.duration_seconds,
            completed: ws.completed,
          })
        }
      }
    }

    // Determine which episodes have at least one non-missing file
    const playableFileSet = new Set<string>()
    if (episodeIds.length > 0) {
      const playableRows = await db
        .select({ media_item_id: mediaFiles.media_item_id })
        .from(mediaFiles)
        .where(and(
          inArray(mediaFiles.media_item_id, episodeIds),
          isNull(mediaFiles.missing_at)
        ))
      for (const row of playableRows) {
        if (row.media_item_id) playableFileSet.add(row.media_item_id)
      }
    }

    const result: EpisodeListItem[] = episodes.map((ep) => ({
      id: ep.id,
      episodeNumber: ep.episode_number ?? 0,
      seasonNumber: ep.season_number ?? 0,
      title: ep.title,
      episodeTitle: ep.episode_title,
      overview: ep.overview,
      runtime: ep.runtime_seconds,
      posterUrl: artworkUrl(ep.id, 'poster', !!ep.poster_path, baseUrl, user.id),
      hasPlayableFile: playableFileSet.has(ep.id),
      watchState: watchStateMap.get(ep.id) ?? null,
    }))

    return ok(result)
  })
}

export async function episodeRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId?: string; baseUrl?: string | null }
) {
  const { db, baseUrl } = opts
  const requireAuth = makeRequireAuth(db)

  // GET /api/v1/episodes/:id/next — next episode after this one (requires auth)
  app.get<{ Params: { id: string } }>(
    '/:id/next',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.user!

      const [episode] = await db
        .select({ id: mediaItems.id, library_id: mediaItems.library_id })
        .from(mediaItems)
        .where(and(eq(mediaItems.id, req.params.id), eq(mediaItems.kind, 'episode')))

      if (!episode) {
        reply.status(404)
        return err('Episode not found')
      }

      if (!await canViewLibrary(user, episode.library_id, db)) {
        reply.status(404)
        return err('Episode not found')
      }

      const next = await getNextEpisode(db, req.params.id, user.id, baseUrl)

      if (next === null) {
        reply.status(404)
        return err('No next episode')
      }

      return ok({ episode: next })
    }
  )

  // GET /api/v1/episodes/:id — episode detail
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!

    const [episode] = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.id, req.params.id), eq(mediaItems.kind, 'episode')))

    if (!episode) {
      reply.status(404)
      return err('Episode not found')
    }

    if (!await canViewLibrary(user, episode.library_id, db)) {
      reply.status(404)
      return err('Episode not found')
    }

    // Get season
    const [season] = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.id, episode.parent_id ?? ''), eq(mediaItems.kind, 'season')))

    if (!season) {
      reply.status(500)
      return err('Season not found for episode')
    }

    // Get show
    const [show] = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.id, season.parent_id ?? ''), eq(mediaItems.kind, 'show')))

    if (!show) {
      reply.status(500)
      return err('Show not found for episode')
    }

    // Check if episode has at least one non-missing media file
    const [playableFileRow] = await db
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .where(and(eq(mediaFiles.media_item_id, episode.id), isNull(mediaFiles.missing_at)))
      .limit(1)

    const detail: EpisodeDetail = {
      id: episode.id,
      episodeNumber: episode.episode_number ?? 0,
      seasonNumber: episode.season_number ?? 0,
      title: episode.title,
      episodeTitle: episode.episode_title,
      overview: episode.overview,
      runtime: episode.runtime_seconds,
      posterUrl: artworkUrl(episode.id, 'poster', !!episode.poster_path, baseUrl, user.id),
      hasPlayableFile: !!playableFileRow,
      showId: show.id,
      showTitle: show.title,
      seasonId: season.id,
      metadataStatus: episode.metadata_status,
      showMetadataStatus: show.metadata_status,
      airDate: episode.release_date,
      watchState: null,
    }

    return ok(detail)
  })
}
