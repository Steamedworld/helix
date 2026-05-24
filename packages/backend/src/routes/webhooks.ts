import type { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { integrations } from '../db/schema'
import type { DrizzleDB } from '../db/client'
import {
  verifyWebhookToken,
  parseRadarrEvent,
  parseSonarrEvent,
  shouldSyncOnRadarrEvent,
  shouldSyncOnSonarrEvent,
  triggerWebhookSync,
  recordWebhookReceived,
} from '../services/integrations/webhook'

export async function webhookRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; dataDir: string }
) {
  const { db, dataDir } = opts

  // POST /api/v1/webhooks/:integrationId/:token
  // No session auth — authenticated by token in path only.
  app.post<{ Params: { integrationId: string; token: string } }>(
    '/:integrationId/:token',
    async (req, reply) => {
      const { integrationId, token } = req.params

      // Load integration
      const [row] = await db
        .select()
        .from(integrations)
        .where(eq(integrations.id, integrationId))

      if (!row) {
        reply.status(404)
        return { ok: false, error: 'Not found' }
      }

      // Reject if webhook not enabled
      if (row.webhook_enabled !== 1) {
        reply.status(403)
        return { ok: false, error: 'Webhook not enabled for this integration' }
      }

      // Reject if no secret configured
      if (!row.webhook_secret_hash) {
        reply.status(403)
        return { ok: false, error: 'Webhook secret not configured' }
      }

      // Reject if integration is disabled
      if (row.enabled !== 1) {
        reply.status(403)
        return { ok: false, error: 'Integration is disabled' }
      }

      // Verify token
      if (!verifyWebhookToken(row.webhook_secret_hash, token)) {
        reply.status(401)
        return { ok: false, error: 'Invalid token' }
      }

      // Parse the payload
      const body = req.body

      let eventType: string | null = null
      let shouldSync = false

      if (row.kind === 'radarr') {
        eventType = parseRadarrEvent(body)
        shouldSync = eventType !== null && shouldSyncOnRadarrEvent(eventType)
      } else if (row.kind === 'sonarr') {
        eventType = parseSonarrEvent(body)
        shouldSync = eventType !== null && shouldSyncOnSonarrEvent(eventType)
      }

      // Record metadata first (non-fatal if this fails)
      try {
        await recordWebhookReceived(db, integrationId, eventType, null)
      } catch {
        // Non-fatal — don't let metadata updates block the response
      }

      // Trigger sync in background (fire-and-forget)
      if (shouldSync) {
        triggerWebhookSync(db, integrationId, dataDir).catch(async (err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err)
          await recordWebhookReceived(db, integrationId, eventType, errMsg).catch(() => {})
        })
      }

      reply.status(204)
      return
    }
  )
}
