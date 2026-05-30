import { lt } from 'drizzle-orm'
import { catalogTombstones } from '../../db/schema'
import type { DrizzleDB } from '../../db/client'
import { logger } from '../../lib/logger'

// ─── Pruning function ─────────────────────────────────────────────────────────

/**
 * Delete catalog_tombstones rows older than retentionDays.
 *
 * Safety:
 *  - Only touches catalog_tombstones — never any other table.
 *  - Idempotent: safe to call repeatedly with the same cutoff.
 *  - Returns the number of rows deleted.
 */
export async function pruneTombstones(
  db: DrizzleDB,
  retentionDays: number
): Promise<{ pruned: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const deleted = await db
    .delete(catalogTombstones)
    .where(lt(catalogTombstones.deleted_at, cutoff))
    .returning({ id: catalogTombstones.id })
  return { pruned: deleted.length }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export interface TombstonePruner {
  start(): void
  stop(): Promise<void>
}

const PRUNE_INTERVAL_MS = 86400000 // 24 hours

export function createTombstonePruner(db: DrizzleDB, retentionDays: number): TombstonePruner {
  let active = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let tickPromise: Promise<void> | null = null

  async function runTick(): Promise<void> {
    try {
      const { pruned } = await pruneTombstones(db, retentionDays)
      if (pruned > 0) {
        logger.info({ pruned, retentionDays }, '[tombstonePruner] Pruned old tombstones')
      }
    } catch (e) {
      // One failure must not crash the server
      logger.warn({ err: e }, '[tombstonePruner] Failed to prune tombstones')
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
      // Run immediately on startup, then schedule daily ticks
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
