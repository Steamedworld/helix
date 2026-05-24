import type { FastifyInstance } from 'fastify'
import { eq, and, sql, count } from 'drizzle-orm'
import { mediaItems, watchStates } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'

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
}

export interface ShowDetail {
  id: string
  title: string
  year: number | null
  posterUrl: string | null
  backdropUrl: string | null
  overview: string | null
  contentRating: string | null
  seasons: SeasonSummary[]
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
  playbackSource?: unknown
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function artworkUrl(
  mediaItemId: string,
  kind: 'poster' | 'backdrop',
  hasPath: boolean,
  baseUrl: string | null | undefined
): string | null {
  if (!hasPath) return null
  const base = baseUrl ?? ''
  return `${base}/api/v1/media/${mediaItemId}/artwork/${kind}`
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function tvRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId?: string; baseUrl?: string | null }
) {
  const { db, baseUrl } = opts

  // GET /api/v1/shows — list all shows
  app.get<{ Querystring: { library_id?: string } }>('/', async (req) => {
    const { library_id } = req.query
    const conditions: Parameters<typeof and>[] = [
      eq(mediaItems.kind, 'show') as any,
    ]
    if (library_id) {
      conditions.push(eq(mediaItems.library_id, library_id) as any)
    }

    const shows = await db
      .select()
      .from(mediaItems)
      .where(and(...(conditions as any[])))
      .orderBy(sql`${mediaItems.sort_title} ASC`)

    // For each show, count episodes
    const result: ShowListItem[] = await Promise.all(
      shows.map(async (show) => {
        // Count all episode descendants
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
          posterUrl: artworkUrl(show.id, 'poster', !!show.poster_path, baseUrl),
          backdropUrl: artworkUrl(show.id, 'backdrop', !!show.backdrop_path, baseUrl),
          episodeCount,
          overview: show.overview,
          metadataStatus: show.metadata_status,
        }
      })
    )

    return ok(result)
  })

  // GET /api/v1/shows/:id — show detail with seasons
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const [show] = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.id, req.params.id), eq(mediaItems.kind, 'show')))

    if (!show) {
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
          posterUrl: artworkUrl(season.id, 'poster', !!season.poster_path, baseUrl),
        }
      })
    )

    const detail: ShowDetail = {
      id: show.id,
      title: show.title,
      year: show.year,
      posterUrl: artworkUrl(show.id, 'poster', !!show.poster_path, baseUrl),
      backdropUrl: artworkUrl(show.id, 'backdrop', !!show.backdrop_path, baseUrl),
      overview: show.overview,
      contentRating: show.content_rating,
      seasons: seasonSummaries,
    }

    return ok(detail)
  })

  // GET /api/v1/shows/:id/seasons — seasons for a show
  app.get<{ Params: { id: string } }>('/:id/seasons', async (req, reply) => {
    const [show] = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(eq(mediaItems.id, req.params.id), eq(mediaItems.kind, 'show')))

    if (!show) {
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
          posterUrl: artworkUrl(season.id, 'poster', !!season.poster_path, baseUrl),
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

  // GET /api/v1/seasons/:id/episodes — episodes for a season (with watch state)
  app.get<{
    Params: { id: string }
    Querystring: { user_id?: string }
  }>('/:id/episodes', async (req, reply) => {
    const { user_id } = req.query
    const DEFAULT_USER_ID = 'default'
    const resolvedUserId = user_id ?? DEFAULT_USER_ID

    const [season] = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.id, req.params.id), eq(mediaItems.kind, 'season')))

    if (!season) {
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
          .where(and(eq(watchStates.media_item_id, epId), eq(watchStates.user_id, resolvedUserId)))
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

    const result: EpisodeListItem[] = episodes.map((ep) => ({
      id: ep.id,
      episodeNumber: ep.episode_number ?? 0,
      seasonNumber: ep.season_number ?? 0,
      title: ep.title,
      episodeTitle: ep.episode_title,
      overview: ep.overview,
      runtime: ep.runtime_seconds,
      posterUrl: artworkUrl(ep.id, 'poster', !!ep.poster_path, baseUrl),
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

  // GET /api/v1/episodes/:id — episode detail
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const [episode] = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.id, req.params.id), eq(mediaItems.kind, 'episode')))

    if (!episode) {
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

    const detail: EpisodeDetail = {
      id: episode.id,
      episodeNumber: episode.episode_number ?? 0,
      seasonNumber: episode.season_number ?? 0,
      title: episode.title,
      episodeTitle: episode.episode_title,
      overview: episode.overview,
      runtime: episode.runtime_seconds,
      posterUrl: artworkUrl(episode.id, 'poster', !!episode.poster_path, baseUrl),
      showId: show.id,
      showTitle: show.title,
      seasonId: season.id,
      watchState: null,
    }

    return ok(detail)
  })
}
