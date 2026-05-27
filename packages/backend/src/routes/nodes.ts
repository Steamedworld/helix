import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { nodes } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { makeRequireAdmin } from '../middleware/auth'
import { encryptApiKey, decryptApiKey } from '../services/integrations/encryption'
import { checkRemoteHealth } from '../services/federation/healthCheck'
import { syncRemoteNode } from '../services/federation/catalogSync'

type NodeRow = typeof nodes.$inferSelect

function sanitizeNode(node: NodeRow) {
  const { api_token_encrypted: _t, federation_token_hash: _h, ...rest } = node
  return {
    ...rest,
    has_federation_token:
      node.kind === 'local' ? !!node.federation_token_hash : !!node.api_token_encrypted,
  }
}

export async function nodeRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId: string; dataDir: string }
) {
  const { db, localNodeId, dataDir } = opts
  const requireAdmin = makeRequireAdmin(db)

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
        await db
          .update(nodes)
          .set({
            status: 'online',
            last_seen_at: now,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .where(eq(nodes.id, node.id))
        return ok({ online: true })
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
        const result = await syncRemoteNode(
          node.id,
          node.base_url,
          node.api_token_encrypted,
          dataDir,
          db
        )
        await db
          .update(nodes)
          .set({
            status: 'online',
            last_seen_at: nowMs,
            last_sync_at: nowMs,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .where(eq(nodes.id, node.id))
        return ok({ ...result, synced: true })
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
}
