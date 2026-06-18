import { lt, inArray, and } from 'drizzle-orm'
import { federatedProgressOutbox, remoteWatchProgress } from '../../db/schema'
import type { DrizzleDB } from '../../db/client'
import { logger } from '../../lib/logger'

// ─── Module-level state ───────────────────────────────────────────────────────

let lastProgressPruneAt: string | null = null
let lastProgressPruneDeletedCount: number | null = null
let lastProgressPruneStatus: 'ok' | 'failed' | 'not_run' = 'not_run'

export interface ProgressPruneState {
  lastProgressPruneAt: string | null
  lastProgressPruneDeletedCount: number | null
  lastProgressPruneStatus: 'ok' | 'failed' | 'not_run'
}

export function getProgressPruneState(): ProgressPruneState {
  return { lastProgressPruneAt, lastProgressPruneDeletedCount, lastProgressPruneStatus }
}

// Terminal outbox statuses that are safe to prune. 'pending' and 'in_progress'
// are active; 'failed' is RETRY-PENDING (the worker re-claims pending+failed),
// so neither is ever pruned. Only 'synced' (delivered) and 'abandoned' (gave up
// after max attempts) are terminal.
const TERMINAL_OUTBOX_STATUSES = ['synced', 'abandoned'] as const

export interface ProgressRetentionOptions {
  outboxRetentionDays: number
  remoteProgressRetentionDays: number
}

// ─── Pruning function ─────────────────────────────────────────────────────────

/**
 * Prune long-term federation progress growth:
 *  - terminal outbox rows (synced/abandoned) older than outboxRetentionDays
 *  - remote_watch_progress rows older than remoteProgressRetentionDays (by updated_at)
 *
 * Safety:
 *  - Never deletes pending / in_progress / failed (retrying) outbox jobs.
 *  - Never deletes recent remote progress.
 *  - Does not interpret viewer identity hashes; never deletes by user/profile/name.
 *  - Idempotent: safe to call repeatedly with the same cutoffs.
 */
export async function pruneProgressData(
  db: DrizzleDB,
  opts: ProgressRetentionOptions
): Promise<{ outboxPruned: number; remoteProgressPruned: number }> {
  const outboxCutoff = new Date(Date.now() - opts.outboxRetentionDays * 24 * 60 * 60 * 1000).toISOString()
  const remoteProgressCutoff = new Date(Date.now() - opts.remoteProgressRetentionDays * 24 * 60 * 60 * 1000).toISOString()

  const outboxDeleted = await db
    .delete(federatedProgressOutbox)
    .where(
      and(
        inArray(federatedProgressOutbox.status, [...TERMINAL_OUTBOX_STATUSES]),
        lt(federatedProgressOutbox.updated_at, outboxCutoff)
      )
    )
    .returning({ id: federatedProgressOutbox.id })

  const remoteDeleted = await db
    .delete(remoteWatchProgress)
    .where(lt(remoteWatchProgress.updated_at, remoteProgressCutoff))
    .returning({ id: remoteWatchProgress.id })

  return { outboxPruned: outboxDeleted.length, remoteProgressPruned: remoteDeleted.length }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export interface ProgressPruner {
  start(): void
  stop(): Promise<void>
}

const PRUNE_INTERVAL_MS = 86400000 // 24 hours

export function createProgressPruner(db: DrizzleDB, opts: ProgressRetentionOptions): ProgressPruner {
  let active = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let tickPromise: Promise<void> | null = null

  async function runTick(): Promise<void> {
    try {
      const { outboxPruned, remoteProgressPruned } = await pruneProgressData(db, opts)
      lastProgressPruneAt = new Date().toISOString()
      lastProgressPruneDeletedCount = outboxPruned + remoteProgressPruned
      lastProgressPruneStatus = 'ok'
      if (outboxPruned > 0 || remoteProgressPruned > 0) {
        logger.info({ outboxPruned, remoteProgressPruned }, '[progressPruner] Pruned terminal outbox / stale remote progress rows')
      }
    } catch (e) {
      lastProgressPruneStatus = 'failed'
      logger.warn({ err: e }, '[progressPruner] Failed to prune progress data')
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
