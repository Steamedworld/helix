import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { nodes, mediaItems } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { makeRequireAdmin, makeRequireAuth } from '../middleware/auth'
import { encryptApiKey, decryptApiKey } from '../services/integrations/encryption'
import { checkRemoteHealth } from '../services/federation/healthCheck'
import { syncRemoteNode } from '../services/federation/catalogSync'
import { canViewLibrary } from '../lib/permissions'
import { fetchRemoteCapabilities, type NodeCapabilities } from '../services/federation/capabilities'
import { isLoopbackUrl } from '../config'

type NodeRow = typeof nodes.$inferSelect

function sanitizeNode(node: NodeRow) {
  const { api_token_encrypted: _t, federation_token_hash: _h, capabilities_json: _c, ...rest } = node
  const capabilities = node.capabilities_json
    ? (() => { try { return JSON.parse(node.capabilities_json) } catch { return null } })()
    : null
  return {
    ...rest,
    has_federation_token:
      node.kind === 'local' ? !!node.federation_token_hash : !!node.api_token_encrypted,
    capabilities,
  }
}

// ─── Direct playback diagnostic ───────────────────────────────────────────────

export interface DirectPlaybackDiagnostic {
  directPlaybackAvailable: boolean
  supportsRemotePlayback: boolean
  baseUrlConfigured: boolean
  publicBaseUrl: string | null
  warning?: string
}

function buildDirectPlaybackDiagnostic(
  capabilities: NodeCapabilities | null,
  remoteBaseUrl: string
): DirectPlaybackDiagnostic {
  if (!capabilities) {
    return {
      directPlaybackAvailable: false,
      supportsRemotePlayback: false,
      baseUrlConfigured: false,
      publicBaseUrl: null,
      warning: 'Remote node capabilities are unknown. Run Test or Sync to fetch them.',
    }
  }

  const supportsRemotePlayback = capabilities.supportsRemotePlayback === true
  const baseUrlConfigured = capabilities.baseUrlConfigured === true
  const publicBaseUrl = capabilities.publicBaseUrl ?? null

  if (!supportsRemotePlayback) {
    return {
      directPlaybackAvailable: false,
      supportsRemotePlayback: false,
      baseUrlConfigured,
      publicBaseUrl,
      warning: 'Remote node does not support direct playback.',
    }
  }

  // Check if public base URL points to a loopback address
  const effectiveStreamHost = publicBaseUrl ?? remoteBaseUrl
  if (!baseUrlConfigured || isLoopbackUrl(effectiveStreamHost)) {
    const loopbackAddr = publicBaseUrl ?? remoteBaseUrl
    return {
      directPlaybackAvailable: true,
      supportsRemotePlayback: true,
      baseUrlConfigured: false,
      publicBaseUrl,
      warning:
        `Remote node BASE_URL is not configured or is a loopback address.` +
        ` Direct playback may fail unless your browser is on the same machine as the remote node (${loopbackAddr}).`,
    }
  }

  return {
    directPlaybackAvailable: true,
    supportsRemotePlayback: true,
    baseUrlConfigured: true,
    publicBaseUrl,
  }
}

export async function nodeRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId: string; dataDir: string }
) {
  const { db, localNodeId, dataDir } = opts
  const requireAdmin = makeRequireAdmin(db)
  const requireAuth = makeRequireAuth(db)

  // GET / — list all nodes
  app.get('/', { preHandler: requireAdmin }, async () => {
    const rows = await db.select().from(nodes)
    return ok(rows.map(sanitizeNode))
  })

  // POST / — add remote node
  app.post<{ Body: { name?: string; base_url?: string; api_token?: string } }>(
    '/',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { name, base_url, api_token } = req.body ?? {}
      if (!name || !base_url || !api_token) {
        reply.status(400)
        return err('name, base_url, and api_token are required')
      }
      try {
        new URL(base_url)
      } catch {
        reply.status(400)
        return err('base_url must be a valid URL')
      }
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const api_token_encrypted = encryptApiKey(api_token, dataDir)
      await db.insert(nodes).values({
        id,
        name,
        kind: 'remote',
        base_url,
        status: 'unknown',
        api_token_encrypted,
        created_at: now,
        updated_at: now,
      })
      const [created] = await db.select().from(nodes).where(eq(nodes.id, id))
      reply.status(201)
      return ok(sanitizeNode(created))
    }
  )

  // GET /:id — node detail
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
    if (!node) {
      reply.status(404)
      return err('Node not found')
    }
    return ok(sanitizeNode(node))
  })

  // PATCH /:id — update remote node
  app.patch<{
    Params: { id: string }
    Body: Partial<{ name: string; base_url: string; api_token: string }>
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
    if (!node) {
      reply.status(404)
      return err('Node not found')
    }
    if (node.kind === 'local') {
      reply.status(400)
      return err('Cannot modify the local node via this endpoint')
    }
    const now = new Date().toISOString()
    const updates: Partial<typeof nodes.$inferInsert> = { updated_at: now }
    if (req.body?.name) updates.name = req.body.name
    if (req.body?.base_url) {
      try {
        new URL(req.body.base_url)
      } catch {
        reply.status(400)
        return err('base_url must be a valid URL')
      }
      updates.base_url = req.body.base_url
    }
    if (req.body?.api_token) {
      updates.api_token_encrypted = encryptApiKey(req.body.api_token, dataDir)
    }
    await db.update(nodes).set(updates).where(eq(nodes.id, req.params.id))
    const [updated] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
    return ok(sanitizeNode(updated))
  })

  // DELETE /:id — delete remote node
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
      if (!node) {
        reply.status(404)
        return err('Node not found')
      }
      if (node.kind === 'local') {
        reply.status(400)
        return err('Cannot delete the local node')
      }
      await db.delete(nodes).where(eq(nodes.id, req.params.id))
      return ok({ deleted: true })
    }
  )

  // POST /:id/test — test connection to remote node
  app.post<{ Params: { id: string } }>(
    '/:id/test',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
      if (!node) {
        reply.status(404)
        return err('Node not found')
      }
      if (node.kind === 'local') {
        reply.status(400)
        return err('Cannot test the local node')
      }
      if (!node.base_url || !node.api_token_encrypted) {
        reply.status(400)
        return err('Node is missing base_url or api_token')
      }
      const rawToken = decryptApiKey(node.api_token_encrypted, dataDir)
      const now = Date.now()
      const result = await checkRemoteHealth(node.base_url, rawToken)
      if (result.online) {
        const capabilities = await fetchRemoteCapabilities(node.base_url, rawToken)
        await db
          .update(nodes)
          .set({
            status: 'online',
            last_seen_at: now,
            last_error: null,
            capabilities_json: capabilities ? JSON.stringify(capabilities) : null,
            updated_at: new Date().toISOString(),
          })
          .where(eq(nodes.id, node.id))
        return ok({ online: true, capabilities: capabilities ?? null })
      } else {
        await db
          .update(nodes)
          .set({
            status: 'error',
            last_error: result.error ?? 'Connection failed',
            updated_at: new Date().toISOString(),
          })
          .where(eq(nodes.id, node.id))
        return ok({ online: false, error: result.error })
      }
    }
  )

  // POST /:id/sync — sync remote catalog
  app.post<{ Params: { id: string } }>(
    '/:id/sync',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
      if (!node) {
        reply.status(404)
        return err('Node not found')
      }
      if (node.kind === 'local') {
        reply.status(400)
        return err('Cannot sync the local node')
      }
      if (!node.base_url || !node.api_token_encrypted) {
        reply.status(400)
        return err('Node is missing base_url or api_token')
      }
      try {
        const nowMs = Date.now()
        const rawTokenForSync = decryptApiKey(node.api_token_encrypted, dataDir)
        const [syncResult, capabilities] = await Promise.all([
          syncRemoteNode(node.id, node.base_url, node.api_token_encrypted, dataDir, db),
          fetchRemoteCapabilities(node.base_url, rawTokenForSync),
        ])
        await db
          .update(nodes)
          .set({
            status: 'online',
            last_seen_at: nowMs,
            last_sync_at: nowMs,
            last_error: null,
            capabilities_json: capabilities ? JSON.stringify(capabilities) : null,
            updated_at: new Date().toISOString(),
          })
          .where(eq(nodes.id, node.id))
        return ok({ ...syncResult, synced: true, capabilities: capabilities ?? null })
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Sync failed'
        await db
          .update(nodes)
          .set({
            status: 'error',
            last_error: errMsg,
            updated_at: new Date().toISOString(),
          })
          .where(eq(nodes.id, node.id))
        reply.status(500)
        return err(errMsg)
      }
    }
  )

  // GET /:id/check — fetch and evaluate direct-playback readiness for a remote node
  app.get<{ Params: { id: string } }>(
    '/:id/check',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
      if (!node) {
        reply.status(404)
        return err('Node not found')
      }
      if (node.kind === 'local') {
        reply.status(400)
        return err('Cannot check the local node')
      }
      if (!node.base_url || !node.api_token_encrypted) {
        reply.status(400)
        return err('Node is missing base_url or api_token')
      }

      // Use cached capabilities if available (from last test/sync); optionally
      // refresh by passing ?refresh=1. This avoids a slow network call on every load.
      let capabilities: NodeCapabilities | null = node.capabilities_json
        ? (() => { try { return JSON.parse(node.capabilities_json) as NodeCapabilities } catch { return null } })()
        : null

      if (!capabilities) {
        // No cached capabilities — try to fetch them now
        const rawToken = decryptApiKey(node.api_token_encrypted, dataDir)
        capabilities = await fetchRemoteCapabilities(node.base_url, rawToken)
        if (capabilities) {
          await db
            .update(nodes)
            .set({ capabilities_json: JSON.stringify(capabilities), updated_at: new Date().toISOString() })
            .where(eq(nodes.id, node.id))
        }
      }

      const diagnostic = buildDirectPlaybackDiagnostic(capabilities, node.base_url)
      return ok(diagnostic)
    }
  )

  // GET /:nodeId/media/:mediaId/artwork/:kind — proxy remote artwork to authenticated user
  app.get<{ Params: { nodeId: string; mediaId: string; kind: string } }>(
    '/:nodeId/media/:mediaId/artwork/:kind',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { nodeId, mediaId, kind } = req.params

      if (kind !== 'poster' && kind !== 'backdrop') {
        reply.status(400)
        return err('kind must be "poster" or "backdrop"')
      }

      const user = req.user!

      // Verify user has permission to view the media item
      const [item] = await db
        .select({ library_id: mediaItems.library_id })
        .from(mediaItems)
        .where(eq(mediaItems.id, mediaId))

      if (!item) {
        reply.status(404)
        return err('Media item not found')
      }

      if (!await canViewLibrary(user, item.library_id, db)) {
        reply.status(404)
        return err('Media item not found')
      }

      // Look up remote node and decrypt token
      const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
      if (!node || node.kind !== 'remote' || !node.base_url || !node.api_token_encrypted) {
        reply.status(404)
        return err('Remote node not found')
      }

      const rawToken = decryptApiKey(node.api_token_encrypted, dataDir)

      let remoteRes: Response
      try {
        remoteRes = await fetch(
          `${node.base_url}/api/v1/federation/media/${mediaId}/artwork/${kind}`,
          {
            headers: { Authorization: `Bearer ${rawToken}` },
            signal: AbortSignal.timeout(15000),
          }
        )
      } catch {
        reply.status(502)
        return err('Remote node unreachable')
      }

      if (remoteRes.status === 404) {
        reply.status(404)
        return err('Artwork not available on remote node')
      }

      if (!remoteRes.ok) {
        reply.status(502)
        return err('Remote node returned an error')
      }

      const contentType = remoteRes.headers.get('content-type') ?? 'application/octet-stream'
      const buffer = Buffer.from(await remoteRes.arrayBuffer())

      reply.header('Content-Type', contentType)
      reply.header('Content-Length', String(buffer.length))
      reply.header('Cache-Control', 'public, max-age=86400')
      return reply.send(buffer)
    }
  )
}
