import type { FastifyInstance } from 'fastify'
import { ok } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { makeRequireAdmin } from '../middleware/auth'
import { enrichmentQueue } from '../services/enrichmentQueue'

export async function enrichmentQueueRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB }
) {
  const { db } = opts
  const requireAdmin = makeRequireAdmin(db)

  // GET /api/v1/enrichment-queue/stats — queue counts and recent failures (admin only)
  app.get('/stats', { preHandler: requireAdmin }, async () => {
    const stats = await enrichmentQueue.getStats(db)
    return ok(stats)
  })

  // POST /api/v1/enrichment-queue/clear — remove all done/failed jobs (admin only)
  app.post('/clear', { preHandler: requireAdmin }, async () => {
    const removed = await enrichmentQueue.clearCompleted(db)
    return ok({ removed })
  })

  // POST /api/v1/enrichment-queue/enqueue — enqueue all unenriched items (admin only)
  app.post('/enqueue', { preHandler: requireAdmin }, async () => {
    const enqueued = await enrichmentQueue.enqueueAll(db)
    return ok({ enqueued })
  })
}
