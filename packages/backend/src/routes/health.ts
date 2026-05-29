import type { FastifyInstance } from 'fastify'
import { ok } from '../lib/response'
import { config } from '../config'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    return ok({
      status: 'ok',
      version: '0.1.0',
      node: 'Helix Local',
      autoSync: {
        enabled: config.trustedHomeSyncEnabled,
        intervalMs: config.trustedHomeSyncIntervalMs,
      },
    })
  })
}
