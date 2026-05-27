import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHash, timingSafeEqual, randomBytes } from 'crypto'
import { createReadStream, existsSync, statSync } from 'fs'
import { extname } from 'path'
import { eq, inArray, gt, and } from 'drizzle-orm'
import { nodes, libraries, mediaItems, mediaVersions, mediaFiles } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { makeRequireAdmin } from '../middleware/auth'
import type { FederationCatalogData } from '../services/federation/catalogSync'
import { makeLocalCapabilities } from '../services/federation/capabilities'

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function makeRequireFederationToken(db: DrizzleDB, localNodeId: string) {
  return async function requireFederationToken(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const authHeader = request.headers['authorization']
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401).send({ ok: false, error: 'Federation token required' })
      return
    }
    const rawToken = authHeader.slice(7)
    const incoming = Buffer.from(hashToken(rawToken), 'hex')

    const [localNode] = await db
      .select({ federation_token_hash: nodes.federation_token_hash })
      .from(nodes)
      .where(eq(nodes.id, localNodeId))

    if (!localNode?.federation_token_hash) {
      reply.status(401).send({ ok: false, error: 'Federation not configured' })
      return
    }

    const stored = Buffer.from(localNode.federation_token_hash, 'hex')
    if (incoming.length !== stored.length || !timingSafeEqual(incoming, stored)) {
      reply.status(401).send({ ok: false, error: 'Invalid federation token' })
      return
    }
  }
}

export async function federationRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId: string; dataDir: string }
) {
  const { db, localNodeId } = opts
  const requireAdmin = makeRequireAdmin(db)
  const requireFederationToken = makeRequireFederationToken(db, localNodeId)

  // ── Token management (admin only) ────────────────────────────────────────────

  // GET /federation/token — check if a token is set
  app.get('/token', { preHandler: requireAdmin }, async () => {
    const [localNode] = await db
      .select({ federation_token_hash: nodes.federation_token_hash })
      .from(nodes)
      .where(eq(nodes.id, localNodeId))

    return ok({ hasToken: !!(localNode?.federation_token_hash) })
  })

  // POST /federation/token — generate or regenerate
  app.post('/token', { preHandler: requireAdmin }, async () => {
    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)
    const now = new Date().toISOString()

    await db
      .update(nodes)
      .set({ federation_token_hash: tokenHash, updated_at: now })
      .where(eq(nodes.id, localNodeId))

    return ok({ token: rawToken })
  })

  // DELETE /federation/token — revoke
  app.delete('/token', { preHandler: requireAdmin }, async () => {
    const now = new Date().toISOString()
    await db
      .update(nodes)
      .set({ federation_token_hash: null, updated_at: now })
      .where(eq(nodes.id, localNodeId))

    return ok({ revoked: true })
  })

  // ── Federation API (federation token only) ────────────────────────────────────

  // GET /federation/health — remote health check
  app.get('/health', { preHandler: requireFederationToken }, async () => {
    const [localNode] = await db
      .select({ id: nodes.id, name: nodes.name })
      .from(nodes)
      .where(eq(nodes.id, localNodeId))

    return ok({
      nodeId: localNode?.id ?? localNodeId,
      nodeName: localNode?.name ?? 'Helix',
      status: 'online',
    })
  })

  // GET /federation/capabilities — advertise what this node supports
  app.get('/capabilities', { preHandler: requireFederationToken }, async () => {
    const [localNode] = await db
      .select({ id: nodes.id, name: nodes.name })
      .from(nodes)
      .where(eq(nodes.id, localNodeId))

    const capabilities = makeLocalCapabilities(
      localNode?.id ?? localNodeId,
      localNode?.name ?? 'Helix'
    )
    return ok(capabilities)
  })

  // POST /federation/playback-intent — placeholder contract; always returns unsupported
  app.post<{
    Body: {
      mediaItemId?: string
      mediaFileId?: string
      requestedMode?: string
      clientInfo?: unknown
    }
  }>('/playback-intent', { preHandler: requireFederationToken }, async () => {
    return ok({
      status: 'unsupported',
      reason: 'Remote playback is not implemented yet.',
    })
  })

  // GET /federation/catalog — export catalog
  app.get<{ Querystring: { since?: string } }>(
    '/catalog',
    { preHandler: requireFederationToken },
    async (req) => {
      const sinceMs = req.query.since ? parseInt(req.query.since, 10) : null
      const sinceIso = sinceMs ? new Date(sinceMs).toISOString() : null

      // Get local node details
      const [localNode] = await db
        .select({ id: nodes.id, name: nodes.name })
        .from(nodes)
        .where(eq(nodes.id, localNodeId))

      // Get all local libraries
      const localLibraries = await db
        .select()
        .from(libraries)
        .where(eq(libraries.node_id, localNodeId))

      const localLibraryIds = localLibraries.map((l) => l.id)

      if (localLibraryIds.length === 0) {
        const catalogData: FederationCatalogData = {
          nodeId: localNodeId,
          nodeName: localNode?.name ?? 'Helix',
          exportedAt: Date.now(),
          libraries: [],
          items: [],
          versions: [],
          files: [],
        }
        return ok(catalogData)
      }

      // Get items (with optional since filter)
      const localItems = await db
        .select()
        .from(mediaItems)
        .where(
          sinceIso
            ? and(
                inArray(mediaItems.library_id, localLibraryIds),
                gt(mediaItems.updated_at, sinceIso)
              )
            : inArray(mediaItems.library_id, localLibraryIds)
        )
      const localItemIds = localItems.map((i) => i.id)

      // Get versions and files for those items
      const localVersions =
        localItemIds.length > 0
          ? await db
              .select()
              .from(mediaVersions)
              .where(inArray(mediaVersions.media_item_id, localItemIds))
          : []

      const localFiles =
        localItemIds.length > 0
          ? await db
              .select()
              .from(mediaFiles)
              .where(
                inArray(mediaFiles.media_item_id, localItemIds)
              )
              // Only local files (no sentinel paths)
              .then((rows) => rows.filter((f) => f.node_id === localNodeId && !f.path.startsWith('remote://')))
          : []

      const catalogData: FederationCatalogData = {
        nodeId: localNodeId,
        nodeName: localNode?.name ?? 'Helix',
        exportedAt: Date.now(),
        libraries: localLibraries.map((lib) => ({
          id: lib.id,
          name: lib.name,
          kind: lib.kind,
          itemCount: localItems.filter((i) => i.library_id === lib.id).length,
        })),
        items: localItems.map((item) => ({
          id: item.id,
          library_id: item.library_id,
          parent_id: item.parent_id,
          kind: item.kind,
          title: item.title,
          sort_title: item.sort_title,
          year: item.year,
          overview: item.overview,
          has_poster: !!item.poster_path,
          has_backdrop: !!item.backdrop_path,
          original_title: item.original_title,
          release_date: item.release_date,
          content_rating: item.content_rating,
          runtime_seconds: item.runtime_seconds,
          season_number: item.season_number,
          episode_number: item.episode_number,
          episode_title: item.episode_title,
          absolute_episode_number: item.absolute_episode_number,
          metadata_status: item.metadata_status,
          external_tmdb_id: item.external_tmdb_id,
          external_tvdb_id: item.external_tvdb_id,
          updated_at: item.updated_at,
        })),
        versions: localVersions.map((v) => ({
          id: v.id,
          media_item_id: v.media_item_id,
          label: v.label,
          quality_label: v.quality_label,
          resolution_width: v.resolution_width,
          resolution_height: v.resolution_height,
          video_codec: v.video_codec,
          audio_codec: v.audio_codec,
          container: v.container,
          duration_seconds: v.duration_seconds,
        })),
        files: localFiles.map((f) => ({
          id: f.id,
          media_item_id: f.media_item_id,
          media_version_id: f.media_version_id,
          filename: f.filename,
          extension: f.extension,
          size_bytes: f.size_bytes,
        })),
      }

      return ok(catalogData)
    }
  )

  // ── Artwork serving (federation token only) ───────────────────────────────────

  // GET /federation/media/:id/artwork/:kind — stream local artwork to remote nodes
  app.get<{ Params: { id: string; kind: string } }>(
    '/media/:id/artwork/:kind',
    { preHandler: requireFederationToken },
    async (req, reply) => {
      const { id, kind } = req.params

      if (kind !== 'poster' && kind !== 'backdrop') {
        reply.status(400)
        return err('kind must be "poster" or "backdrop"')
      }
      const artworkKind = kind as 'poster' | 'backdrop'

      // Look up the item — must belong to a local library (not an imported remote item)
      const [item] = await db
        .select({
          id: mediaItems.id,
          poster_path: mediaItems.poster_path,
          backdrop_path: mediaItems.backdrop_path,
        })
        .from(mediaItems)
        .innerJoin(libraries, eq(mediaItems.library_id, libraries.id))
        .where(and(eq(mediaItems.id, id), eq(libraries.node_id, localNodeId)))

      if (!item) {
        reply.status(404)
        return err('Media item not found')
      }

      const artworkPath = artworkKind === 'poster' ? item.poster_path : item.backdrop_path

      if (!artworkPath || artworkPath.startsWith('remote-artwork://')) {
        reply.status(404)
        return err(`No ${artworkKind} artwork for this item`)
      }

      if (!existsSync(artworkPath)) {
        reply.status(404)
        return err('Artwork file not found on disk')
      }

      let fileSize: number
      try {
        const stat = statSync(artworkPath)
        fileSize = stat.size
      } catch {
        reply.status(500)
        return err('Failed to stat artwork file')
      }

      const EXT_MIME: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
      }
      const ext = extname(artworkPath).toLowerCase()
      const mimeType = EXT_MIME[ext] ?? 'application/octet-stream'

      reply.header('Content-Type', mimeType)
      reply.header('Content-Length', String(fileSize))
      reply.header('Cache-Control', 'public, max-age=86400')

      return reply.send(createReadStream(artworkPath))
    }
  )
}
