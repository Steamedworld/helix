import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { nodes } from '../db/schema'
import { ok } from '../lib/response'
import { config } from '../config'
import { computeSyncHealthRollup } from '../services/federation/syncHealthRollup'
import type { DrizzleDB } from '../db/client'

export async function healthRoutes(app: FastifyInstance, opts: { db?: DrizzleDB } = {}) {
  const { db } = opts

  app.get('/health', async () => {
    // Query trusted-home (remote) nodes — aggregate only, no per-node details exposed
    let trustedHomeSync = {
      total: 0,
      healthy: 0,
      failing: 0,
      stale: 0,
      neverSynced: 0,
      unknown: 0,
      hasFailures: false,
      syncStatus: 'unknown' as 'ok' | 'degraded' | 'unknown',
      tombstoneRetentionDays: config.tombstoneRetentionDays,
      oldestActiveErrorAt: null as string | null,
      newestAttemptAt: null as string | null,
    }

    if (db) {
      const remoteNodes = await db
        .select({
          last_sync_at: nodes.last_sync_at,
          last_sync_attempt_at: nodes.last_sync_attempt_at,
          last_sync_error_at: nodes.last_sync_error_at,
          last_sync_error_code: nodes.last_sync_error_code,
          last_sync_error_message: nodes.last_sync_error_message,
        })
        .from(nodes)
        .where(sql`${nodes.kind} = 'remote'`)

      const rollup = computeSyncHealthRollup(remoteNodes, config.tombstoneRetentionDays)
      trustedHomeSync = {
        ...rollup,
        tombstoneRetentionDays: config.tombstoneRetentionDays,
      }
    }

    return ok({
      status: 'ok',
      version: '0.1.0',
      node: 'Helix Local',
      autoSync: {
        enabled: config.trustedHomeSyncEnabled,
        intervalMs: config.trustedHomeSyncIntervalMs,
      },
      tombstoneRetentionDays: config.tombstoneRetentionDays,
      trustedHomeSync,
    })
  })
}
