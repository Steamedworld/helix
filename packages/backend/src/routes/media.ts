import type { FastifyInstance } from 'fastify'
import { eq, and, like, sql } from 'drizzle-orm'
import { mediaItems, mediaVersions, mediaFiles } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import type { MediaItemKind } from '@helix/shared'
import { getPlaybackSource } from '../services/federation/sourceSelection'

// Build public artwork URL — never expose raw filesystem path to client
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

export async function mediaRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId?: string; baseUrl?: string | null }
) {
  const { db, localNodeId, baseUrl } = opts

  // GET /media
  app.get<{
    Querystring: {
      library_id?: string
      kind?: MediaItemKind
      q?: string
      limit?: string
      offset?: string
    }
  }>('/', async (req) => {
    const { library_id, kind, q, limit = '50', offset = '0' } = req.query
    const conditions = []

    if (library_id) conditions.push(eq(mediaItems.library_id, library_id))
    if (kind) conditions.push(eq(mediaItems.kind, kind))
    if (q) conditions.push(like(mediaItems.title, `%${q}%`))

    const rows = await db
      .select()
      .from(mediaItems)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .limit(parseInt(limit, 10))
      .offset(parseInt(offset, 10))
      .orderBy(sql`${mediaItems.created_at} DESC`)

    const enriched = rows.map((item) => ({
      ...item,
      poster_path: undefined,
      backdrop_path: undefined,
      posterUrl: artworkUrl(item.id, 'poster', !!item.poster_path, baseUrl),
      backdropUrl: artworkUrl(item.id, 'backdrop', !!item.backdrop_path, baseUrl),
      // Provide a kind label for search results
      kindLabel:
        item.kind === 'show'
          ? 'Show'
          : item.kind === 'season'
          ? 'Season'
          : item.kind === 'episode'
          ? `Episode S${String(item.season_number ?? 0).padStart(2, '0')}E${String(item.episode_number ?? 0).padStart(2, '0')}`
          : item.kind === 'movie'
          ? 'Movie'
          : item.kind,
    }))

    return ok(enriched)
  })

  // GET /media/:id
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const [item] = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.id, req.params.id))
    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    const versions = await db
      .select()
      .from(mediaVersions)
      .where(eq(mediaVersions.media_item_id, item.id))

    const files = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.media_item_id, item.id))

    return ok({
      ...item,
      poster_path: undefined,
      backdrop_path: undefined,
      posterUrl: artworkUrl(item.id, 'poster', !!item.poster_path, baseUrl),
      backdropUrl: artworkUrl(item.id, 'backdrop', !!item.backdrop_path, baseUrl),
      versions,
      files,
    })
  })

  // GET /media/:id/versions
  app.get<{ Params: { id: string } }>('/:id/versions', async (req, reply) => {
    const [item] = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.id, req.params.id))
    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    const versions = await db
      .select()
      .from(mediaVersions)
      .where(eq(mediaVersions.media_item_id, req.params.id))

    return ok(versions)
  })

  // GET /media/:id/files
  app.get<{ Params: { id: string } }>('/:id/files', async (req, reply) => {
    const [item] = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.id, req.params.id))
    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    const files = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.media_item_id, req.params.id))

    return ok(files)
  })

  // GET /media/:id/playback-source — pick best available local file
  app.get<{ Params: { id: string } }>('/:id/playback-source', async (req, reply) => {
    if (!localNodeId) {
      reply.status(503)
      return err('Local node not available')
    }

    const [item] = await db
      .select({ id: mediaItems.id, kind: mediaItems.kind })
      .from(mediaItems)
      .where(eq(mediaItems.id, req.params.id))

    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    const result = await getPlaybackSource(req.params.id, db, localNodeId, baseUrl ?? null)
    return ok(result)
  })
}
