import { lt } from 'drizzle-orm'
import { trustedHomeAuditEvents } from '../../db/schema'
import type { DrizzleDB } from '../../db/client'
import { logger } from '../../lib/logger'

// ─── Module-level state ───────────────────────────────────────────────────────

let lastPruneAt: string | null = null
let lastPruneDeletedCount: number | null = null
let lastPruneStatus: 'ok' | 'failed' | 'not_run' = 'not_run'

export interface AuditPruneState {
  lastPruneAt: string | null
  lastPruneDeletedCount: number | null
  lastPruneStatus: 'ok' | 'failed' | 'not_run'
}

export function getAuditPruneState(): AuditPruneState {
  return { lastPruneAt, lastPruneDeletedCount, lastPruneStatus }
}

// ─── Pruning function ─────────────────────────────────────────────────────────

/**
 * Delete trusted_home_audit_events rows older than retentionDays.
 *
 * Safety:
 *  - Only touches trusted_home_audit_events — never any other table.
 *  - Idempotent: safe to call repeatedly with the same cutoff.
 *  - Returns the number of rows deleted.
 */
export async function pruneAuditEvents(
  db: DrizzleDB,
  retentionDays: number
): Promise<{ pruned: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const deleted = await db
    .delete(trustedHomeAuditEvents)
    .where(lt(trustedHomeAuditEvents.occurred_at, cutoff))
    .returning({ id: trustedHomeAuditEvents.id })
  return { pruned: deleted.length }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export interface AuditPruner {
  start(): void
  stop(): Promise<void>
}

const PRUNE_INTERVAL_MS = 86400000 // 24 hours

export function createAuditPruner(db: DrizzleDB, retentionDays: number): AuditPruner {
  let active = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let tickPromise: Promise<void> | null = null

  async function runTick(): Promise<void> {
    try {
      const { pruned } = await pruneAuditEvents(db, retentionDays)
      const now = new Date().toISOString()
      lastPruneAt = now
      lastPruneDeletedCount = pruned
      lastPruneStatus = 'ok'
      if (pruned > 0) {
        logger.info({ pruned, retentionDays }, '[auditPruner] Pruned old audit events')
      }
    } catch (e) {
      lastPruneStatus = 'failed'
      logger.warn({ err: e }, '[auditPruner] Failed to prune audit events')
    }
  }

  function scheduleNext(): void {
    if (!active) return
    pendingTimer = setTimeout(() => {
      if (!active) return
      tickPromise = runTick().then(() => {
        tickPromise = null
        scheduleNext()
      }).catch(() => {
        tickPromise = null
        scheduleNext()
      })
    }, PRUNE_INTERVAL_MS)
  }

  return {
    start(): void {
      if (active) return
      active = true
      tickPromise = runTick().then(() => {
        tickPromise = null
        scheduleNext()
      }).catch(() => {
        tickPromise = null
        scheduleNext()
      })
    },

    async stop(): Promise<void> {
      active = false
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer)
        pendingTimer = null
      }
      if (tickPromise) {
        await tickPromise.catch(() => {})
        tickPromise = null
      }
    },
  }
}
