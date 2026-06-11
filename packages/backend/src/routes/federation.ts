import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHash, timingSafeEqual, randomBytes } from 'crypto'
import { createReadStream, existsSync, statSync } from 'fs'
import { extname } from 'path'
import { eq, inArray, gt, and, or, sql } from 'drizzle-orm'
import { nodes, libraries, mediaItems, mediaVersions, mediaFiles, trustedHomeInvites, catalogTombstones } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { makeRequireAdmin } from '../middleware/auth'
import type { FederationCatalogData, FederationTombstone } from '../services/federation/catalogSync'
import { makeLocalCapabilities } from '../services/federation/capabilities'
import { signStreamToken } from '../lib/signedTokens'
import { config } from '../config'
import { remoteWatchProgress } from '../db/schema'
import { recordAuditEvent } from '../services/federation/auditEvents'
import { isValidViewerIdentityHash } from '../services/federation/viewerIdentity'

const CONTAINER_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
}

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
  opts: { db: DrizzleDB; localNodeId: string; dataDir: string; baseUrl?: string | null }
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

  // ── Invite verification (invite token only, not federation token) ─────────────

  /**
   * POST /federation/invites/verify
   *
   * Authenticates with the raw invite token (Bearer <raw-token>).
   * Returns safe source-home info if the invite is valid.
   * Does NOT mark used_at here — only /consume does that.
   */
  app.post(
    '/invites/verify',
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Must NOT accept session cookies for this endpoint — invite token only
      const authHeader = req.headers['authorization']
      if (!authHeader?.startsWith('Bearer ')) {
        reply.status(403)
        return err('Invite token required in Authorization: Bearer <token>')
      }
      const rawToken = authHeader.slice(7).trim()
      if (!rawToken) {
        reply.status(403)
        return err('Invite token is empty')
      }

      const tokenHash = createHash('sha256').update(rawToken).digest('hex')

      const [invite] = await db
        .select()
        .from(trustedHomeInvites)
        .where(eq(trustedHomeInvites.token_hash, tokenHash))

      if (!invite) {
        reply.status(403)
        return err('Invite not found or invalid')
      }

      const now = Date.now()

      if (invite.revoked_at !== null) {
        reply.status(403)
        return err('This invite has been revoked.')
      }
      if (invite.expires_at !== null && invite.expires_at < now) {
        reply.status(403)
        return err('This invite has expired.')
      }
      if (invite.used_at !== null) {
        reply.status(403)
        return err('This invite has already been used.')
      }

      // Look up local node info for the response
      const [localNode] = await db
        .select({ name: nodes.name })
        .from(nodes)
        .where(eq(nodes.id, localNodeId))

      const homeName = localNode?.name ?? 'Helix'
      const serverAddress =
        opts.baseUrl ?? config.baseUrl ?? null

      return ok({
        valid: true,
        home_name: homeName,
        server_address: serverAddress ?? '',
        capabilities: {
          federation: true,
          catalog: true,
          artwork: true,
          playback: true,
        },
        label: invite.label,
        expires_at: invite.expires_at ? new Date(invite.expires_at).toISOString() : null,
        invite_id: invite.id,
      })
    }
  )

  /**
   * POST /federation/invites/consume
   *
   * Authenticates with the raw invite token (Bearer <raw-token>).
   * Marks the invite as used (sets used_at). One-time enforcement.
   * Accepts optional connecting_home_name and connecting_home_address in body.
   */
  app.post<{
    Body: { connecting_home_name?: string; connecting_home_address?: string }
  }>(
    '/invites/consume',
    async (req: FastifyRequest<{ Body: { connecting_home_name?: string; connecting_home_address?: string } }>, reply: FastifyReply) => {
      // Must NOT accept session cookies — invite token only
      const authHeader = req.headers['authorization']
      if (!authHeader?.startsWith('Bearer ')) {
        reply.status(403)
        return err('Invite token required in Authorization: Bearer <token>')
      }
      const rawToken = authHeader.slice(7).trim()
      if (!rawToken) {
        reply.status(403)
        return err('Invite token is empty')
      }

      const tokenHash = createHash('sha256').update(rawToken).digest('hex')

      const [invite] = await db
        .select()
        .from(trustedHomeInvites)
        .where(eq(trustedHomeInvites.token_hash, tokenHash))

      if (!invite) {
        reply.status(403)
        return err('Invite not found or invalid')
      }

      const now = Date.now()

      if (invite.revoked_at !== null) {
        reply.status(403)
        return err('This invite has been revoked.')
      }
      if (invite.expires_at !== null && invite.expires_at < now) {
        reply.status(403)
        return err('This invite has expired.')
      }
      if (invite.used_at !== null) {
        reply.status(403)
        return err('This invite has already been used.')
      }

      const { connecting_home_name, connecting_home_address } = req.body ?? {}

      await db
        .update(trustedHomeInvites)
        .set({
          used_at: now,
          updated_at: now,
          ...(connecting_home_name ? { used_by_home_name: String(connecting_home_name) } : {}),
          ...(connecting_home_address ? { used_by_address: String(connecting_home_address) } : {}),
        })
        .where(eq(trustedHomeInvites.id, invite.id))

      return ok({
        consumed: true,
        used_at: new Date(now).toISOString(),
      })
    }
  )

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

  // POST /federation/playback-intent — generate a short-lived signed stream URL for a remote caller
  app.post<{
    Body: {
      mediaItemId?: string
      mediaFileId?: string
      requestedMode?: string
      clientInfo?: unknown
    }
  }>('/playback-intent', { preHandler: requireFederationToken }, async (req, reply) => {
    const { mediaItemId, mediaFileId, requestedMode } = req.body ?? {}

    // Only "direct" mode is supported
    if (requestedMode && requestedMode !== 'direct') {
      return ok({ status: 'unsupported', reason: `Mode "${requestedMode}" is not supported. Supported modes: direct.` })
    }

    // Need at least one identifier
    if (!mediaItemId && !mediaFileId) {
      reply.status(400)
      return err('mediaItemId or mediaFileId is required')
    }

    // Resolve the file to stream
    let file: typeof mediaFiles.$inferSelect | undefined

    if (mediaFileId) {
      const [row] = await db
        .select()
        .from(mediaFiles)
        .where(eq(mediaFiles.id, mediaFileId))
      file = row ?? undefined
    } else {
      // mediaItemId given — pick best local file (first non-missing local one)
      const rows = await db
        .select()
        .from(mediaFiles)
        .where(
          and(
            eq(mediaFiles.media_item_id, mediaItemId!),
            eq(mediaFiles.node_id, localNodeId)
          )
        )
      file = rows.find((f) => f.missing_at === null && existsSync(f.path))
    }

    if (!file) {
      return ok({ status: 'unavailable', reason: 'file_missing' })
    }

    // Confirm file belongs to this (local) node — reject imported/sentinel remote items
    if (file.node_id !== localNodeId) {
      reply.status(400)
      return err('Requested item does not belong to this node')
    }

    // Confirm it is a real path (not a sentinel)
    if (file.path.startsWith('remote://')) {
      reply.status(400)
      return err('Requested item is a remote sentinel record, not a local file')
    }

    // Confirm file exists on disk and is not stale
    if (file.missing_at !== null || !existsSync(file.path)) {
      return ok({ status: 'unavailable', reason: 'file_missing' })
    }

    // Look up the version for content-type metadata
    const [version] = await db
      .select({ container: mediaVersions.container })
      .from(mediaVersions)
      .where(eq(mediaVersions.id, file.media_version_id))

    // Generate signed stream URL — use a synthetic federation caller ID so the token
    // is scoped to this specific file request and cannot be reused for other files.
    const federationCallerId = `federation-caller:${localNodeId}`
    const token = signStreamToken(file.id, federationCallerId)

    // Build stream URL — we need the node's own base URL to produce an absolute URL.
    // Use the BASE_URL / PUBLIC_URL env var if set (via config); fall back to a
    // localhost default. The caller should set BASE_URL to the URL browsers use to
    // reach this server — otherwise remote direct playback will only work on localhost.
    const nodeBaseUrl =
      opts.baseUrl ??
      config.baseUrl ??
      `http://localhost:${config.port}`
    const streamUrl = `${nodeBaseUrl}/api/v1/media-files/${file.id}/stream?token=${token}`

    const ttlSeconds = Number(process.env.MEDIA_TOKEN_TTL_SECONDS ?? 14400)
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()

    // CORS note: the browser will make a cross-origin request to this node's stream URL.
    // The stream endpoint already sends Accept-Ranges and standard headers; no additional
    // CORS config is needed on the stream endpoint itself because the browser fetches it
    // via the <video> src attribute (not a fetch() call), which is not subject to CORS.

    return ok({
      status: 'ready',
      mode: 'direct',
      streamUrl,
      expiresAt,
      mediaFileId: file.id,
      contentType: version?.container
        ? (CONTAINER_MIME[version.container.toLowerCase()] ?? null)
        : null,
      container: version?.container ?? null,
    })
  })

  // GET /federation/catalog — export catalog
  // Supports optional ?since=<ISO8601> for incremental sync.
  // Without ?since: returns full catalog.
  // With ?since: returns only items updated at or after that timestamp, plus all
  // parent library records for context. Returns 400 for an unparseable timestamp.
  app.get<{ Querystring: { since?: string } }>(
    '/catalog',
    { preHandler: requireFederationToken },
    async (req, reply) => {
      const sinceRaw = req.query.since

      // Parse the since timestamp — accept ISO8601 or millisecond epoch strings.
      let sinceIso: string | null = null
      let incremental = false

      if (sinceRaw !== undefined && sinceRaw !== '') {
        // Try ISO8601 first (contains letters or hyphens after first char)
        const asDate = new Date(sinceRaw)
        if (!isNaN(asDate.getTime())) {
          sinceIso = asDate.toISOString()
          incremental = true
        } else {
          // Unparseable timestamp
          reply.status(400)
          return err('Invalid since parameter: must be an ISO 8601 timestamp (e.g. 2026-05-01T00:00:00Z)')
        }
      }

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

      // Fetch tombstones for incremental responses
      // Always scoped to localNodeId — never expose tombstones from other nodes
      let tombstoneList: FederationTombstone[] = []
      if (incremental && sinceIso) {
        const tombstoneRows = await db
          .select({
            entity_type: catalogTombstones.entity_type,
            entity_id: catalogTombstones.entity_id,
            deleted_at: catalogTombstones.deleted_at,
            reason: catalogTombstones.reason,
          })
          .from(catalogTombstones)
          .where(
            and(
              eq(catalogTombstones.node_id, localNodeId),
              gt(catalogTombstones.deleted_at, sinceIso)
            )
          )
        tombstoneList = tombstoneRows.map((r) => ({
          entityType: r.entity_type,
          entityId: r.entity_id,
          deletedAt: r.deleted_at,
          reason: r.reason ?? undefined,
        }))
      }

      if (localLibraryIds.length === 0) {
        const catalogData: FederationCatalogData = {
          nodeId: localNodeId,
          nodeName: localNode?.name ?? 'Helix',
          exportedAt: Date.now(),
          incremental,
          since: sinceIso ?? undefined,
          libraries: [],
          items: [],
          versions: [],
          files: [],
          tombstones: incremental ? tombstoneList : [],
        }
        return ok(catalogData)
      }

      // Get items — when ?since is provided, include any item where:
      //   - media_items.updated_at >= since, OR
      //   - any of its media_versions has updated_at >= since, OR
      //   - any of its media_files has updated_at >= since
      // We use a subquery to find item IDs touched via version/file changes,
      // then union with the direct item filter for correctness on all SQLite versions.
      let localItems: (typeof mediaItems.$inferSelect)[]
      if (sinceIso) {
        // IDs of items whose own updated_at qualifies
        const directItems = await db
          .select({ id: mediaItems.id })
          .from(mediaItems)
          .where(
            and(
              inArray(mediaItems.library_id, localLibraryIds),
              gt(mediaItems.updated_at, sinceIso)
            )
          )

        // IDs of items that have a version updated since sinceIso
        const versionTouchedItems = await db
          .selectDistinct({ id: mediaVersions.media_item_id })
          .from(mediaVersions)
          .innerJoin(mediaItems, eq(mediaVersions.media_item_id, mediaItems.id))
          .where(
            and(
              inArray(mediaItems.library_id, localLibraryIds),
              gt(mediaVersions.updated_at, sinceIso)
            )
          )

        // IDs of items that have a file updated since sinceIso
        const fileTouchedItems = await db
          .selectDistinct({ id: mediaFiles.media_item_id })
          .from(mediaFiles)
          .innerJoin(mediaItems, eq(mediaFiles.media_item_id, mediaItems.id))
          .where(
            and(
              inArray(mediaItems.library_id, localLibraryIds),
              eq(mediaFiles.node_id, localNodeId),
              gt(mediaFiles.updated_at, sinceIso)
            )
          )

        // Union all touched item IDs
        const touchedIds = new Set<string>([
          ...directItems.map((r) => r.id),
          ...versionTouchedItems.map((r) => r.id),
          ...fileTouchedItems.map((r) => r.id),
        ])

        if (touchedIds.size === 0) {
          localItems = []
        } else {
          localItems = await db
            .select()
            .from(mediaItems)
            .where(inArray(mediaItems.id, [...touchedIds]))
        }
      } else {
        localItems = await db
          .select()
          .from(mediaItems)
          .where(inArray(mediaItems.library_id, localLibraryIds))
      }
      const localItemIds = localItems.map((i) => i.id)

      // For incremental responses, always include all library records (so the
      // importer has context even if the library itself didn't change).
      // For full responses this is the same set.
      const librariesToExport = localLibraries

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
        incremental,
        since: sinceIso ?? undefined,
        versionsSynced: localVersions.length,
        filesSynced: localFiles.length,
        tombstones: incremental ? tombstoneList : [],
        libraries: librariesToExport.map((lib) => ({
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

  // ── Source-side media stream (federation token only) ──────────────────────────

  /**
   * GET  /federation/media/:id/stream
   * HEAD /federation/media/:id/stream
   *
   * Streams a local media file to a remote Trusted Home proxy.
   * Authentication: Bearer federation token.
   * Security:
   *   - Rejects items where node_id != localNodeId (proxy loop prevention).
   *   - Never exposes media_files.path in any response header or body.
   *   - Supports Range requests (bytes=X-Y, bytes=X-, bytes=-Y).
   */
  async function handleFederationMediaStream(
    req: import('fastify').FastifyRequest<{ Params: { id: string } }>,
    reply: import('fastify').FastifyReply
  ) {
    const mediaItemId = req.params.id

    // Find a suitable local file for this item — only non-missing files on the local node
    const candidateFiles = await db
      .select()
      .from(mediaFiles)
      .where(
        and(
          eq(mediaFiles.media_item_id, mediaItemId),
          eq(mediaFiles.node_id, localNodeId)
        )
      )

    const file = candidateFiles.find(
      (f) => f.missing_at === null && !f.path.startsWith('remote://')
    )

    if (!file) {
      reply.status(404)
      reply.header('Content-Type', 'application/json')
      return reply.send(JSON.stringify({ ok: false, error: 'Media file not found' }))
    }

    // Confirm item belongs to local node (proxy loop prevention)
    if (file.node_id !== localNodeId) {
      reply.status(404)
      reply.header('Content-Type', 'application/json')
      return reply.send(JSON.stringify({ ok: false, error: 'Media file not found' }))
    }

    // Confirm file exists on disk — never expose the path itself
    if (!existsSync(file.path)) {
      reply.status(404)
      reply.header('Content-Type', 'application/json')
      return reply.send(JSON.stringify({ ok: false, error: 'Media file not found on disk' }))
    }

    // Get file size
    let fileSize: number
    try {
      const stat = statSync(file.path)
      fileSize = stat.size
    } catch {
      reply.status(500)
      reply.header('Content-Type', 'application/json')
      return reply.send(JSON.stringify({ ok: false, error: 'Stream unavailable' }))
    }

    // Derive content-type from extension — never expose path
    const ext = file.extension.toLowerCase()
    const mimeType = CONTAINER_MIME[ext] ?? 'video/mp4'

    const rangeHeader = req.headers.range

    reply.header('Accept-Ranges', 'bytes')
    reply.header('Content-Type', mimeType)

    // HEAD requests: same headers, no body
    const isHead = req.method === 'HEAD'

    if (rangeHeader) {
      // Parse range: bytes=X-Y, bytes=X-, bytes=-Y
      const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
      if (!match) {
        // Unparseable range
        reply.status(400)
        reply.header('Content-Type', 'application/json')
        return reply.send(JSON.stringify({ ok: false, error: 'Invalid Range header' }))
      }

      const rawStart = match[1]
      const rawEnd = match[2]

      if (rawStart === '' && rawEnd === '') {
        reply.status(400)
        reply.header('Content-Type', 'application/json')
        return reply.send(JSON.stringify({ ok: false, error: 'Invalid Range header' }))
      }

      let start: number
      let end: number

      if (rawStart === '') {
        // suffix-length: bytes=-N
        const suffix = parseInt(rawEnd, 10)
        if (suffix <= 0 || isNaN(suffix)) {
          reply.status(416)
          reply.header('Content-Range', `bytes */${fileSize}`)
          return reply.send()
        }
        start = Math.max(0, fileSize - suffix)
        end = fileSize - 1
      } else {
        start = parseInt(rawStart, 10)
        end = rawEnd !== '' ? parseInt(rawEnd, 10) : fileSize - 1
      }

      if (isNaN(start) || isNaN(end) || start > end) {
        reply.status(416)
        reply.header('Content-Range', `bytes */${fileSize}`)
        return reply.send()
      }

      // Unsatisfiable: start >= fileSize
      if (start >= fileSize) {
        reply.status(416)
        reply.header('Content-Range', `bytes */${fileSize}`)
        return reply.send()
      }

      end = Math.min(end, fileSize - 1)
      const chunkSize = end - start + 1

      reply.status(206)
      reply.header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
      reply.header('Content-Length', String(chunkSize))

      if (isHead) return reply.send()

      const stream = createReadStream(file.path, { start, end })
      // Abort stream on client disconnect
      req.raw.on('close', () => stream.destroy())
      return reply.send(stream)
    }

    // Full file
    reply.status(200)
    reply.header('Content-Length', String(fileSize))

    if (isHead) return reply.send()

    const stream = createReadStream(file.path)
    req.raw.on('close', () => stream.destroy())
    return reply.send(stream)
  }

  app.get<{ Params: { id: string } }>(
    '/media/:id/stream',
    { preHandler: requireFederationToken },
    handleFederationMediaStream
  )

  app.head<{ Params: { id: string } }>(
    '/media/:id/stream',
    { preHandler: requireFederationToken },
    handleFederationMediaStream
  )

  // ── Source-side federated watch-progress receiver ─────────────────────────────

  /**
   * PUT /federation/media/:id/watch-progress
   *
   * Receives watch-progress pushes from a viewer Trusted Home (bilateral opt-in).
   *
   * Security:
   *   - Requires federation token → identifies calling node (not a user)
   *   - Caller node must have allow_progress_push = 1 (viewer Home opt-in)
   *   - Local node must have allow_progress_receive = 1 (source Home opt-in)
   *   - Media item must belong to local node (not an imported sentinel)
   *   - Viewer identity is derived from caller node ID (no local user ID exposed)
   *   - Conflict rule: newer updatedAt wins; equal timestamps → prefer higher position
   *   - watched=true only accepted when positionSeconds >= durationSeconds * 0.90
   *   - positionSeconds must not exceed durationSeconds * 1.01 (1% rounding tolerance)
   *   - updatedAt must not be more than 5 minutes in the future
   *
   * MUST NOT expose: viewer session ID, local user IDs, filesystem paths,
   * stack traces, upstream URLs, or authorization values.
   */
  app.put<{
    Params: { id: string }
    Body: {
      positionSeconds: unknown
      durationSeconds: unknown
      watched: unknown
      updatedAt: unknown
      clientEventId?: unknown
      viewerIdentity?: unknown
    }
  }>(
    '/media/:id/watch-progress',
    { preHandler: requireFederationToken },
    async (req, reply) => {
      const mediaItemId = req.params.id

      // ── Step 1: find the calling node (already auth-verified by requireFederationToken) ──
      // The federation token uniquely identifies the local node only — it does NOT identify
      // the calling remote node. We look up the caller by re-checking the token to find
      // which remote node corresponds to this call.
      //
      // Design note: the federation token is stored on the LOCAL node (it's the token
      // that remote nodes use to call us). All remote nodes calling us share ONE federation
      // token. To identify the caller for progress attribution, we use a caller-identity
      // header if present, or fall back to a nonce from the body.
      //
      // For v1, use the clientEventId as a stable hash input. The remote viewer identity is:
      //   sha256(callerNodeId + ':' + clientEventId)[0..31]
      // Without clientEventId: sha256(callerNodeId)[0..31]
      //
      // For caller identification we require the caller to send X-Caller-Node-Id header.
      // If absent, we use a generic "unknown" caller scoped to no specific remote node.
      const callerNodeIdHeader = (req.headers['x-caller-node-id'] as string | undefined)?.trim() ?? ''

      // Find the calling node — must be remote, active
      let callerNode: typeof nodes.$inferSelect | null = null
      if (callerNodeIdHeader) {
        const [row] = await db
          .select()
          .from(nodes)
          .where(and(eq(nodes.id, callerNodeIdHeader), eq(nodes.kind, 'remote')))
          .limit(1)
        callerNode = row ?? null
      }

      // Even without a caller node ID we proceed — caller's ability to push is governed by
      // the local node's allow_progress_receive setting. If no caller node found, we use
      // a generic hash. But we still check allow_progress_push per caller if identified.
      if (callerNode && !callerNode.allow_progress_push) {
        recordAuditEvent(db, { action: 'remote_progress_received', result: 'denied', reasonCode: 'read_denied_no_sync', nodeId: callerNode.id })
        reply.status(403)
        return err('Progress sync not enabled for this connection.')
      }

      // ── Step 2: check local node allow_progress_receive ─────────────────────
      const [localNodeRow] = await db
        .select({
          id: nodes.id,
          allow_progress_receive: nodes.allow_progress_receive,
        })
        .from(nodes)
        .where(eq(nodes.id, localNodeId))
        .limit(1)

      if (!localNodeRow?.allow_progress_receive) {
        recordAuditEvent(db, { action: 'remote_progress_received', result: 'denied', reasonCode: 'read_denied_no_sync', nodeId: callerNodeIdHeader || undefined })
        reply.status(403)
        return err('Progress sync not enabled for this connection.')
      }

      // ── Step 3: find local media item — must belong to local node ───────────
      const [item] = await db
        .select({
          id: mediaItems.id,
          library_id: mediaItems.library_id,
        })
        .from(mediaItems)
        .innerJoin(libraries, eq(mediaItems.library_id, libraries.id))
        .where(
          and(
            eq(mediaItems.id, mediaItemId),
            eq(libraries.node_id, localNodeId)
          )
        )
        .limit(1)

      if (!item) {
        reply.status(404)
        return err('Media item not found')
      }

      // ── Step 4: validate request body ────────────────────────────────────────
      const body = req.body ?? {}
      const { positionSeconds, durationSeconds, watched, updatedAt, clientEventId, viewerIdentity } = body

      if (
        typeof positionSeconds !== 'number' ||
        !isFinite(positionSeconds) ||
        positionSeconds < 0 ||
        positionSeconds > 999999
      ) {
        reply.status(400)
        return err('positionSeconds must be a finite number between 0 and 999999')
      }

      if (
        typeof durationSeconds !== 'number' ||
        !isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        durationSeconds > 999999
      ) {
        reply.status(400)
        return err('durationSeconds must be a finite positive number no greater than 999999')
      }

      if (typeof watched !== 'boolean') {
        reply.status(400)
        return err('watched must be a boolean')
      }

      if (typeof updatedAt !== 'string') {
        reply.status(400)
        return err('updatedAt must be an ISO8601 string')
      }

      const updatedAtDate = new Date(updatedAt)
      if (isNaN(updatedAtDate.getTime())) {
        reply.status(400)
        return err('updatedAt must be a valid ISO8601 timestamp')
      }

      // Reject timestamps more than 5 minutes in the future
      const nowMs = Date.now()
      if (updatedAtDate.getTime() > nowMs + 5 * 60 * 1000) {
        reply.status(400)
        return err('updatedAt is too far in the future')
      }

      // Validate clientEventId if provided
      let safeClientEventId: string | null = null
      if (clientEventId !== undefined) {
        if (typeof clientEventId !== 'string' || clientEventId.length > 64 || !/^[a-zA-Z0-9\-_]+$/.test(clientEventId)) {
          reply.status(400)
          return err('clientEventId must be an alphanumeric string (max 64 chars, a-z A-Z 0-9 - _)')
        }
        safeClientEventId = clientEventId
      }

      // ── Validate optional per-user viewer identity (user_v1) ───────────────────
      // Strict: reject malformed/unsupported identity rather than coercing.
      // The provided hash is an opaque HMAC — never re-hashed, never logged/audited.
      let providedUserHash: string | null = null
      if (viewerIdentity !== undefined && viewerIdentity !== null) {
        if (typeof viewerIdentity !== 'object') {
          reply.status(400)
          return err('viewerIdentity must be an object')
        }
        const vi = viewerIdentity as { kind?: unknown; version?: unknown; hash?: unknown }
        if (vi.kind !== 'node' && vi.kind !== 'user') {
          reply.status(400)
          return err('viewerIdentity.kind must be "node" or "user"')
        }
        if (vi.kind === 'user') {
          if (vi.version !== 'v1') {
            reply.status(400)
            return err('viewerIdentity.version must be "v1"')
          }
          if (!isValidViewerIdentityHash(vi.hash)) {
            reply.status(400)
            return err('viewerIdentity.hash must be 32 lowercase hex characters')
          }
          providedUserHash = vi.hash
        }
      }

      // positionSeconds must not exceed durationSeconds * 1.01 (1% rounding tolerance)
      if (positionSeconds > durationSeconds * 1.01) {
        reply.status(422)
        return ok({ accepted: false, reason: 'positionSeconds exceeds durationSeconds' })
      }

      // watched=true only accepted when positionSeconds >= durationSeconds * 0.90
      if (watched && positionSeconds < durationSeconds * 0.90) {
        reply.status(422)
        return ok({ accepted: false, reason: 'watched=true requires at least 90% completion' })
      }

      // ── Step 5: derive viewer identity ───────────────────────────────────────
      // Never stores viewer session ID or local user ID
      const callerIdForHash = callerNodeIdHeader || localNodeId
      const hashInput = safeClientEventId
        ? `${callerIdForHash}:${safeClientEventId}`
        : callerIdForHash
      const nodeViewerHash = createHash('sha256').update(hashInput).digest('hex').slice(0, 32)

      // Decide identity mode. user_v1 only when the source (this Home) has opted in
      // for this caller. One-sided opt-in → downgrade to node_v1 (no retry storm,
      // no lost progress). The provided opaque hash is stored verbatim (no re-wrap).
      let remoteViewerHash = nodeViewerHash
      let viewerIdentityKind: 'node' | 'user' = 'node'
      let identityDowngraded = false
      if (providedUserHash) {
        if (callerNode?.allow_progress_user_identity) {
          remoteViewerHash = providedUserHash
          viewerIdentityKind = 'user'
        } else {
          identityDowngraded = true
        }
      }

      // ── Step 6: upsert with conflict rules ──────────────────────────────────
      const updatedAtIso = updatedAtDate.toISOString()
      const now = new Date().toISOString()

      const [existing] = await db
        .select()
        .from(remoteWatchProgress)
        .where(
          and(
            eq(remoteWatchProgress.source_node_id, callerIdForHash),
            eq(remoteWatchProgress.remote_viewer_hash, remoteViewerHash),
            eq(remoteWatchProgress.media_item_id, mediaItemId)
          )
        )
        .limit(1)

      if (existing) {
        // Newer updatedAt wins
        const existingDate = new Date(existing.updated_at)
        if (existingDate > updatedAtDate) {
          // Stored is newer — skip (idempotent 200)
          recordAuditEvent(db, { action: 'remote_progress_received', result: 'skipped', reasonCode: 'progress_stale_ignored', nodeId: callerIdForHash })
          return ok({ accepted: false, reason: 'stale update ignored' })
        }

        // Equal timestamps: prefer higher positionSeconds
        if (existingDate.getTime() === updatedAtDate.getTime() && existing.position_seconds >= positionSeconds) {
          recordAuditEvent(db, { action: 'remote_progress_received', result: 'skipped', reasonCode: 'progress_stale_ignored', nodeId: callerIdForHash })
          return ok({ accepted: false, reason: 'stale update ignored' })
        }

        await db
          .update(remoteWatchProgress)
          .set({
            position_seconds: positionSeconds,
            duration_seconds: durationSeconds,
            watched: watched ? 1 : 0,
            updated_at: updatedAtIso,
            client_event_id: safeClientEventId,
            viewer_identity_kind: viewerIdentityKind,
          })
          .where(eq(remoteWatchProgress.id, existing.id))
      } else {
        await db.insert(remoteWatchProgress).values({
          id: crypto.randomUUID(),
          source_node_id: callerIdForHash,
          remote_viewer_hash: remoteViewerHash,
          media_item_id: mediaItemId,
          position_seconds: positionSeconds,
          duration_seconds: durationSeconds,
          watched: watched ? 1 : 0,
          updated_at: updatedAtIso,
          client_event_id: safeClientEventId,
          viewer_identity_kind: viewerIdentityKind,
          created_at: now,
        })
      }

      if (identityDowngraded) {
        // One-sided opt-in: per-user identity was requested but this Home has not
        // opted in. Progress stored in node_v1 mode; record the downgrade (no hash).
        recordAuditEvent(db, { action: 'remote_progress_received', result: 'skipped', reasonCode: 'per_user_identity_downgraded', nodeId: callerIdForHash })
      } else {
        recordAuditEvent(db, { action: 'remote_progress_received', result: 'success', reasonCode: 'progress_received', nodeId: callerIdForHash })
      }
      return ok({ accepted: true })
    }
  )

  // ── Source-side remote progress read ──────────────────────────────────────────

  /**
   * GET /federation/media/:id/remote-progress
   *
   * Returns the most recent remote watch-progress record for a media item,
   * scoped to the calling node (identified via federation token + X-Caller-Node-Id).
   *
   * Auth: federation Bearer token.
   * Validation order:
   *   1. Federation auth verified by requireFederationToken (401 if invalid)
   *   2. Caller node must be remote + trusted + have progress_sync_enabled && allow_progress_receive → 403
   *   3. Media item must belong to local node (proxy loop prevention) → 404
   *   4. Query remote_watch_progress for caller node + media item
   *
   * NEVER returns: remote_viewer_hash, user IDs, paths, tokens, credentials,
   * raw errors, stack traces, or upstream response body.
   *
   * Aggregate: if multiple viewer hashes exist for the same caller + media,
   * returns the most recently updated row (v1 per-node aggregate).
   */
  app.get<{ Params: { id: string } }>(
    '/media/:id/remote-progress',
    { preHandler: requireFederationToken },
    async (req, reply) => {
      const mediaItemId = req.params.id

      // ── Step 1: identify caller node ───────────────────────────────────────────
      const callerNodeIdHeader = (req.headers['x-caller-node-id'] as string | undefined)?.trim() ?? ''

      let callerNode: typeof nodes.$inferSelect | null = null
      if (callerNodeIdHeader) {
        const [row] = await db
          .select()
          .from(nodes)
          .where(and(eq(nodes.id, callerNodeIdHeader), eq(nodes.kind, 'remote')))
          .limit(1)
        callerNode = row ?? null
      }

      if (!callerNode) {
        recordAuditEvent(db, { action: 'remote_progress_read_denied', result: 'denied', reasonCode: 'read_denied_no_node' })
        reply.status(403)
        return err('Caller node not identified — provide X-Caller-Node-Id header')
      }

      // ── Step 2: check bilateral opt-in ─────────────────────────────────────────
      if (!callerNode.progress_sync_enabled || !callerNode.allow_progress_receive) {
        recordAuditEvent(db, { action: 'remote_progress_read_denied', result: 'denied', reasonCode: 'read_denied_no_sync', nodeId: callerNode.id })
        reply.status(403)
        return err('Progress sync not enabled for this connection.')
      }

      // ── Step 3: find local media item — must belong to local node ───────────────
      const [item] = await db
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .innerJoin(libraries, eq(mediaItems.library_id, libraries.id))
        .where(
          and(
            eq(mediaItems.id, mediaItemId),
            eq(libraries.node_id, localNodeId)
          )
        )
        .limit(1)

      if (!item) {
        reply.status(404)
        return err('Media item not found')
      }

      // ── Step 4: optional per-user viewer identity (header-only transport) ───────
      // The hash travels ONLY in server-to-server headers — never a query parameter
      // (no leaking into access/proxy logs or referrers).
      const idKindHeader = (req.headers['x-viewer-identity-kind'] as string | undefined)?.trim() ?? ''
      const idVersionHeader = (req.headers['x-viewer-identity-version'] as string | undefined)?.trim() ?? ''
      const idHashHeader = (req.headers['x-viewer-identity-hash'] as string | undefined)?.trim() ?? ''

      if (idKindHeader === 'user') {
        // Per-user read requested. Require valid identity AND source-side opt-in.
        // On any miss/invalid/not-allowed → available:false with NO aggregate fallback
        // (falling back would leak another household member's position).
        if (
          idVersionHeader !== 'v1' ||
          !isValidViewerIdentityHash(idHashHeader) ||
          !callerNode.allow_progress_user_identity
        ) {
          return ok({
            mediaId: mediaItemId,
            remoteProgress: { available: false as const },
          })
        }

        const [userRow] = await db
          .select({
            position_seconds: remoteWatchProgress.position_seconds,
            duration_seconds: remoteWatchProgress.duration_seconds,
            watched: remoteWatchProgress.watched,
            updated_at: remoteWatchProgress.updated_at,
          })
          .from(remoteWatchProgress)
          .where(
            and(
              eq(remoteWatchProgress.source_node_id, callerNode.id),
              eq(remoteWatchProgress.media_item_id, mediaItemId),
              eq(remoteWatchProgress.viewer_identity_kind, 'user'),
              eq(remoteWatchProgress.remote_viewer_hash, idHashHeader)
            )
          )
          .limit(1)

        if (!userRow) {
          return ok({
            mediaId: mediaItemId,
            remoteProgress: { available: false as const },
          })
        }

        return ok({
          mediaId: mediaItemId,
          remoteProgress: {
            available: true as const,
            positionSeconds: userRow.position_seconds,
            durationSeconds: userRow.duration_seconds ?? null,
            watched: userRow.watched === 1,
            updatedAt: userRow.updated_at,
          },
        })
      }

      // ── Node mode (default, unchanged) — aggregate by most recent updatedAt ──────
      // Multiple viewer hashes possible; return most recently updated row (v1 aggregate).
      const rows = await db
        .select({
          position_seconds: remoteWatchProgress.position_seconds,
          duration_seconds: remoteWatchProgress.duration_seconds,
          watched: remoteWatchProgress.watched,
          updated_at: remoteWatchProgress.updated_at,
        })
        .from(remoteWatchProgress)
        .where(
          and(
            eq(remoteWatchProgress.source_node_id, callerNode.id),
            eq(remoteWatchProgress.media_item_id, mediaItemId)
          )
        )

      if (rows.length === 0) {
        return ok({
          mediaId: mediaItemId,
          remoteProgress: { available: false as const },
        })
      }

      // Pick the most recently updated row
      const best = rows.reduce((a, b) =>
        new Date(a.updated_at).getTime() >= new Date(b.updated_at).getTime() ? a : b
      )

      // MUST NOT include: remote_viewer_hash, user IDs, paths, tokens
      return ok({
        mediaId: mediaItemId,
        remoteProgress: {
          available: true as const,
          positionSeconds: best.position_seconds,
          durationSeconds: best.duration_seconds ?? null,
          watched: best.watched === 1,
          updatedAt: best.updated_at,
        },
      })
    }
  )
}
