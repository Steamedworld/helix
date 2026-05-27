import type { FastifyInstance } from 'fastify'
import { eq, and, like, sql, inArray } from 'drizzle-orm'
import { mediaItems, mediaVersions, mediaFiles, externalMediaLinks, integrations } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import type { MediaItemKind } from '@helix/shared'
import { getPlaybackSource } from '../services/federation/sourceSelection'
import { makeRequireAuth } from '../middleware/auth'
import { canViewLibrary, canPlayLibrary, getViewableLibraryIds } from '../lib/permissions'
import { signArtworkToken } from '../lib/signedTokens'

function artworkUrl(
  mediaItemId: string,
  kind: 'poster' | 'backdrop',
  pathValue: string | null | undefined,
  baseUrl: string | null | undefined,
  userId?: string
): string | null {
  if (!pathValue) return null
  const base = baseUrl ?? ''
  if (pathValue.startsWith('remote-artwork://')) {
    const nodeId = pathValue.slice('remote-artwork://'.length)
    return `${base}/api/v1/nodes/${nodeId}/media/${mediaItemId}/artwork/${kind}`
  }
  const path = `${base}/api/v1/media/${mediaItemId}/artwork/${kind}`
  if (!userId) return path
  const token = signArtworkToken(mediaItemId, kind, userId)
  return `${path}?token=${token}`
}

export async function mediaRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId?: string; baseUrl?: string | null; dataDir?: string }
) {
  const { db, localNodeId, baseUrl, dataDir } = opts
  const requireAuth = makeRequireAuth(db)

  // GET /media
  app.get<{
    Querystring: {
      library_id?: string
      kind?: MediaItemKind
      q?: string
      limit?: string
      offset?: string
    }
  }>('/', { preHandler: requireAuth }, async (req) => {
    const user = req.user!
    const { library_id, kind, q, limit = '50', offset = '0' } = req.query

    // Build library filter based on permissions
    const viewableIds = user.role === 'admin' ? null : await getViewableLibraryIds(user, db)
    if (viewableIds !== null && viewableIds.length === 0) return ok([])

    const conditions: ReturnType<typeof eq>[] = []

    if (library_id) {
      if (viewableIds !== null && !viewableIds.includes(library_id)) {
        return ok([])
      }
      conditions.push(eq(mediaItems.library_id, library_id))
    } else if (viewableIds !== null) {
      conditions.push(inArray(mediaItems.library_id, viewableIds))
    }

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
      posterUrl: artworkUrl(item.id, 'poster', item.poster_path, baseUrl, user.id),
      backdropUrl: artworkUrl(item.id, 'backdrop', item.backdrop_path, baseUrl, user.id),
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
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!

    const [item] = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.id, req.params.id))
    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    if (!await canViewLibrary(user, item.library_id, db)) {
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
          eq(externalMediaLinks.media_item_id, item.id),
          eq(integrations.enabled, 1)
        )
      )

    const integrationLinks = linkRows.map((r) => ({
      kind: r.kind,
      integrationName: r.name,
      monitored: r.monitored === 1,
      qualityProfile: r.qualityProfile,
      externalTitle: r.externalTitle,
    }))

    return ok({
      ...item,
      poster_path: undefined,
      backdrop_path: undefined,
      posterUrl: artworkUrl(item.id, 'poster', item.poster_path, baseUrl, user.id),
      backdropUrl: artworkUrl(item.id, 'backdrop', item.backdrop_path, baseUrl, user.id),
      versions,
      files,
      integrationLinks,
    })
  })

  // GET /media/:id/versions
  app.get<{ Params: { id: string } }>('/:id/versions', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!

    const [item] = await db
      .select({ id: mediaItems.id, library_id: mediaItems.library_id })
      .from(mediaItems)
      .where(eq(mediaItems.id, req.params.id))
    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    if (!await canViewLibrary(user, item.library_id, db)) {
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
  app.get<{ Params: { id: string } }>('/:id/files', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!

    const [item] = await db
      .select({ id: mediaItems.id, library_id: mediaItems.library_id })
      .from(mediaItems)
      .where(eq(mediaItems.id, req.params.id))
    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    if (!await canPlayLibrary(user, item.library_id, db)) {
      reply.status(403)
      return err('Playback not permitted for this library')
    }

    const files = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.media_item_id, req.params.id))

    return ok(files)
  })

  // GET /media/:id/playback-source — requires auth and canPlay
  app.get<{ Params: { id: string } }>('/:id/playback-source', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!

    if (!localNodeId) {
      reply.status(503)
      return err('Local node not available')
    }

    const [item] = await db
      .select({ id: mediaItems.id, kind: mediaItems.kind, library_id: mediaItems.library_id })
      .from(mediaItems)
      .where(eq(mediaItems.id, req.params.id))

    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    if (!await canPlayLibrary(user, item.library_id, db)) {
      reply.status(403)
      return err('Playback not permitted for this library')
    }

    const result = await getPlaybackSource(req.params.id, db, localNodeId, baseUrl ?? null, user.id, dataDir)
    return ok(result)
  })
}
