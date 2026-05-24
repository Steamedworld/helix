import type { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { integrations, externalMediaLinks } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { makeRequireAdmin } from '../middleware/auth'
import { encryptApiKey, decryptApiKey, maskApiKey } from '../services/integrations/encryption'
import { testConnection as radarrTest } from '../services/integrations/providers/radarr'
import { testConnection as sonarrTest } from '../services/integrations/providers/sonarr'
import { syncIntegration } from '../services/integrations/service'
import { generateWebhookToken } from '../services/integrations/webhook'

function formatIntegration(row: typeof integrations.$inferSelect, dataDir: string) {
  let apiKeyMasked = '****'
  try {
    const plain = decryptApiKey(row.api_key_encrypted, dataDir)
    apiKeyMasked = maskApiKey(plain)
  } catch {
    // If decryption fails, just show placeholder
  }

  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.base_url,
    apiKeyMasked,
    enabled: row.enabled === 1,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    webhookEnabled: row.webhook_enabled === 1,
    webhookConfigured: row.webhook_secret_hash !== null,
    lastWebhookAt: row.last_webhook_at,
    lastWebhookEvent: row.last_webhook_event,
    lastWebhookError: row.last_webhook_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function integrationRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; dataDir: string }
) {
  const { db, dataDir } = opts
  const requireAdmin = makeRequireAdmin(db)

  // GET /api/v1/integrations — list all (admin only)
  app.get('/', { preHandler: requireAdmin }, async () => {
    const rows = await db.select().from(integrations)
    return ok(rows.map((r) => formatIntegration(r, dataDir)))
  })

  // POST /api/v1/integrations — create (admin only)
  app.post<{
    Body: {
      kind: string
      name: string
      baseUrl: string
      apiKey: string
      enabled?: boolean
    }
  }>('/', { preHandler: requireAdmin }, async (req, reply) => {
    const { kind, name, baseUrl, apiKey, enabled = true } = req.body ?? {}

    if (!kind || !name || !baseUrl || !apiKey) {
      reply.status(400)
      return err('kind, name, baseUrl, and apiKey are required')
    }

    const validKinds = ['radarr', 'sonarr', 'lidarr', 'prowlarr', 'other']
    if (!validKinds.includes(kind)) {
      reply.status(400)
      return err(`kind must be one of: ${validKinds.join(', ')}`)
    }

    let encryptedKey: string
    try {
      encryptedKey = encryptApiKey(apiKey, dataDir)
    } catch (e: unknown) {
      reply.status(500)
      return err(`Failed to encrypt API key: ${e instanceof Error ? e.message : String(e)}`)
    }

    const now = Date.now()
    const id = crypto.randomUUID()

    await db.insert(integrations).values({
      id,
      kind: kind as any,
      name,
      base_url: baseUrl,
      api_key_encrypted: encryptedKey,
      enabled: enabled ? 1 : 0,
      status: 'unknown',
      last_checked_at: null,
      last_synced_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    })

    const [created] = await db.select().from(integrations).where(eq(integrations.id, id))
    reply.status(201)
    return ok(formatIntegration(created, dataDir))
  })

  // GET /api/v1/integrations/:id (admin only)
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const [row] = await db.select().from(integrations).where(eq(integrations.id, req.params.id))
    if (!row) {
      reply.status(404)
      return err('Integration not found')
    }
    return ok(formatIntegration(row, dataDir))
  })

  // PATCH /api/v1/integrations/:id (admin only)
  app.patch<{
    Params: { id: string }
    Body: {
      name?: string
      baseUrl?: string
      apiKey?: string
      enabled?: boolean
      webhookEnabled?: boolean
    }
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const [row] = await db.select().from(integrations).where(eq(integrations.id, req.params.id))
    if (!row) {
      reply.status(404)
      return err('Integration not found')
    }

    const { name, baseUrl, apiKey, enabled, webhookEnabled } = req.body ?? {}
    const updates: Partial<typeof integrations.$inferInsert> = {
      updated_at: Date.now(),
    }

    if (name !== undefined) updates.name = name
    if (baseUrl !== undefined) updates.base_url = baseUrl
    if (enabled !== undefined) updates.enabled = enabled ? 1 : 0
    if (webhookEnabled !== undefined) updates.webhook_enabled = webhookEnabled ? 1 : 0
    if (apiKey !== undefined) {
      try {
        updates.api_key_encrypted = encryptApiKey(apiKey, dataDir)
      } catch (e: unknown) {
        reply.status(500)
        return err(`Failed to encrypt API key: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    await db.update(integrations).set(updates).where(eq(integrations.id, req.params.id))
    const [updated] = await db.select().from(integrations).where(eq(integrations.id, req.params.id))
    return ok(formatIntegration(updated, dataDir))
  })

  // DELETE /api/v1/integrations/:id (admin only)
  app.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const [row] = await db.select().from(integrations).where(eq(integrations.id, req.params.id))
    if (!row) {
      reply.status(404)
      return err('Integration not found')
    }
    // external_media_links will cascade delete
    await db.delete(integrations).where(eq(integrations.id, req.params.id))
    return ok({ deleted: true })
  })

  // POST /api/v1/integrations/:id/test (admin only)
  app.post<{ Params: { id: string } }>('/:id/test', { preHandler: requireAdmin }, async (req, reply) => {
    const [row] = await db.select().from(integrations).where(eq(integrations.id, req.params.id))
    if (!row) {
      reply.status(404)
      return err('Integration not found')
    }

    let apiKey: string
    try {
      apiKey = decryptApiKey(row.api_key_encrypted, dataDir)
    } catch (e: unknown) {
      reply.status(500)
      return err(`Failed to decrypt API key: ${e instanceof Error ? e.message : String(e)}`)
    }

    let testResult: { ok: boolean; version?: string; error?: string }

    if (row.kind === 'radarr') {
      testResult = await radarrTest(row.base_url, apiKey)
    } else if (row.kind === 'sonarr') {
      testResult = await sonarrTest(row.base_url, apiKey)
    } else {
      testResult = { ok: false, error: `No test implementation for kind: ${row.kind}` }
    }

    const now = Date.now()
    const newStatus = testResult.ok ? 'online' : 'error'
    await db.update(integrations).set({
      status: newStatus,
      last_checked_at: now,
      last_error: testResult.error ?? null,
      updated_at: now,
    }).where(eq(integrations.id, row.id))

    const [updated] = await db.select().from(integrations).where(eq(integrations.id, row.id))
    return ok({
      integration: formatIntegration(updated, dataDir),
      testResult,
    })
  })

  // POST /api/v1/integrations/:id/sync (admin only)
  app.post<{ Params: { id: string } }>('/:id/sync', { preHandler: requireAdmin }, async (req, reply) => {
    const [row] = await db.select().from(integrations).where(eq(integrations.id, req.params.id))
    if (!row) {
      reply.status(404)
      return err('Integration not found')
    }

    const syncResult = await syncIntegration(db, req.params.id, dataDir)
    return ok(syncResult)
  })

  // POST /api/v1/integrations/:id/webhook-secret — generate (or regenerate) webhook secret (admin only)
  // Returns the plaintext token exactly once. Store it in Radarr/Sonarr; it is not retrievable again.
  app.post<{ Params: { id: string } }>('/:id/webhook-secret', { preHandler: requireAdmin }, async (req, reply) => {
    const [row] = await db.select().from(integrations).where(eq(integrations.id, req.params.id))
    if (!row) {
      reply.status(404)
      return err('Integration not found')
    }

    const { token, hash } = generateWebhookToken()
    const now = Date.now()

    await db.update(integrations).set({
      webhook_secret_hash: hash,
      webhook_enabled: 1,
      updated_at: now,
    }).where(eq(integrations.id, row.id))

    const [updated] = await db.select().from(integrations).where(eq(integrations.id, row.id))

    return ok({
      integration: formatIntegration(updated, dataDir),
      webhookToken: token,
      webhookUrl: `/api/v1/webhooks/${row.id}/${token}`,
      note: 'This token will not be shown again. Copy it now and configure it in Radarr or Sonarr.',
    })
  })

  // GET /api/v1/integrations/:id/items — list external_media_links (admin only)
  app.get<{ Params: { id: string } }>('/:id/items', { preHandler: requireAdmin }, async (req, reply) => {
    const [row] = await db.select().from(integrations).where(eq(integrations.id, req.params.id))
    if (!row) {
      reply.status(404)
      return err('Integration not found')
    }

    const links = await db
      .select()
      .from(externalMediaLinks)
      .where(eq(externalMediaLinks.integration_id, req.params.id))

    return ok(links.map((l) => ({
      id: l.id,
      mediaItemId: l.media_item_id,
      integrationId: l.integration_id,
      externalKind: l.external_kind,
      externalId: l.external_id,
      externalGuid: l.external_guid,
      externalTitle: l.external_title,
      monitored: l.monitored === 1,
      qualityProfile: l.quality_profile,
      rootPath: l.root_path,
      lastSyncedAt: l.last_synced_at,
    })))
  })
}
