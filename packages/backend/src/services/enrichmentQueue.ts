import { eq, inArray, and, or, lt, count, desc, asc } from 'drizzle-orm'
import { enrichmentJobs, mediaItems } from '../db/schema'
import type { DrizzleDB } from '../db/client'
import { enrichMediaItem } from './metadata/enrichment'
import { logger } from '../lib/logger'
import { config } from '../config'

const POLL_INTERVAL_MS = 5000
const DEFAULT_MAX_ATTEMPTS = 3

// Terminal-success statuses: no retry needed, mark done
const DONE_STATUSES = new Set(['matched', 'needs_review', 'skipped', 'no_provider', 'parent_unmatched'])

export interface QueueStats {
  pending: number
  running: number
  done: number
  failed: number
  recentFailed: Array<{
    id: string
    mediaItemId: string
    lastError: string | null
    updatedAt: number
  }>
  recoveredOnStartup: number
}

export class EnrichmentQueue {
  private active = false
  private db: DrizzleDB | null = null
  private recoveredOnStartup = 0
  private periodicTimer: ReturnType<typeof setTimeout> | null = null

  start(db: DrizzleDB): void {
    if (this.active) return
    this.db = db
    this.active = true
    this.recoverStaleJobs(db).then((n) => {
      this.recoveredOnStartup = n
      if (n > 0) logger.info({ recovered: n }, 'Recovered stale enrichment jobs on startup')
    }).catch(() => {})
    this.scheduleLoop()
    if (config.enrichmentPeriodicEnabled) {
      this.schedulePeriodicEnqueue()
    }
  }

  stop(): void {
    this.active = false
    this.db = null
    if (this.periodicTimer) {
      clearTimeout(this.periodicTimer)
      this.periodicTimer = null
    }
  }

  // Reset jobs stuck in 'running' state left over from a crashed server process.
  async recoverStaleJobs(db: DrizzleDB, staleAfterMs?: number): Promise<number> {
    const threshold = staleAfterMs ?? config.enrichmentJobStaleAfterMs
    const cutoff = Date.now() - threshold
    const stale = await db
      .select({ id: enrichmentJobs.id })
      .from(enrichmentJobs)
      .where(and(eq(enrichmentJobs.status, 'running'), lt(enrichmentJobs.updated_at, cutoff)))
    if (stale.length === 0) return 0
    await db
      .update(enrichmentJobs)
      .set({
        status: 'pending',
        last_error: 'Recovered from interrupted server shutdown.',
        updated_at: Date.now(),
      })
      .where(and(eq(enrichmentJobs.status, 'running'), lt(enrichmentJobs.updated_at, cutoff)))
    return stale.length
  }

  // Reset all failed jobs back to pending so they will be retried.
  async retryFailed(db: DrizzleDB): Promise<number> {
    const failed = await db
      .select({ id: enrichmentJobs.id })
      .from(enrichmentJobs)
      .where(eq(enrichmentJobs.status, 'failed'))
    if (failed.length === 0) return 0
    await db
      .update(enrichmentJobs)
      .set({ status: 'pending', attempts: 0, last_error: null, updated_at: Date.now() })
      .where(eq(enrichmentJobs.status, 'failed'))
    return failed.length
  }

  // Enqueue item IDs for enrichment. Skips items that already have a pending/running job.
  // Returns the number of jobs actually inserted.
  async enqueue(db: DrizzleDB, mediaItemIds: string[]): Promise<number> {
    if (!config.metadataEnrichmentEnabled) return 0
    if (mediaItemIds.length === 0) return 0

    // Find items already in an active (non-terminal) state
    const existing = await db
      .select({ media_item_id: enrichmentJobs.media_item_id })
      .from(enrichmentJobs)
      .where(
        and(
          inArray(enrichmentJobs.media_item_id, mediaItemIds),
          or(
            eq(enrichmentJobs.status, 'pending'),
            eq(enrichmentJobs.status, 'running')
          )
        )
      )

    const existingSet = new Set(existing.map((r) => r.media_item_id))
    const toInsert = mediaItemIds.filter((id) => !existingSet.has(id))
    if (toInsert.length === 0) return 0

    const now = Date.now()
    await db.insert(enrichmentJobs).values(
      toInsert.map((id) => ({
        id: crypto.randomUUID(),
        media_item_id: id,
        status: 'pending' as const,
        attempts: 0,
        max_attempts: DEFAULT_MAX_ATTEMPTS,
        last_error: null,
        created_at: now,
        updated_at: now,
      }))
    )

    return toInsert.length
  }

  // Enqueue all unenriched items from a specific library, shows first.
  async enqueueLibraryItems(db: DrizzleDB, libraryId: string): Promise<number> {
    const unenriched = await db
      .select({ id: mediaItems.id, kind: mediaItems.kind })
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.library_id, libraryId),
          or(
            eq(mediaItems.metadata_status, 'unknown'),
            eq(mediaItems.metadata_status, 'local')
          )
        )
      )

    if (unenriched.length === 0) return 0

    const kindPriority: Record<string, number> = { show: 0, movie: 1, episode: 2 }
    const sorted = [...unenriched].sort(
      (a, b) => (kindPriority[a.kind] ?? 3) - (kindPriority[b.kind] ?? 3)
    )

    return this.enqueue(db, sorted.map((i) => i.id))
  }

  // Enqueue all unenriched items across all libraries.
  async enqueueAll(db: DrizzleDB): Promise<number> {
    const unenriched = await db
      .select({ id: mediaItems.id, kind: mediaItems.kind })
      .from(mediaItems)
      .where(
        or(
          eq(mediaItems.metadata_status, 'unknown'),
          eq(mediaItems.metadata_status, 'local')
        )
      )

    if (unenriched.length === 0) return 0

    const kindPriority: Record<string, number> = { show: 0, movie: 1, episode: 2 }
    const sorted = [...unenriched].sort(
      (a, b) => (kindPriority[a.kind] ?? 3) - (kindPriority[b.kind] ?? 3)
    )

    return this.enqueue(db, sorted.map((i) => i.id))
  }

  async getStats(db: DrizzleDB): Promise<QueueStats> {
    const rows = await db
      .select({ status: enrichmentJobs.status, n: count() })
      .from(enrichmentJobs)
      .groupBy(enrichmentJobs.status)

    const stats: QueueStats = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      recentFailed: [],
      recoveredOnStartup: this.recoveredOnStartup,
    }

    for (const row of rows) {
      const s = row.status as keyof typeof stats
      if (s === 'pending' || s === 'running' || s === 'done' || s === 'failed') {
        stats[s] = row.n
      }
    }

    const recentFailed = await db
      .select({
        id: enrichmentJobs.id,
        media_item_id: enrichmentJobs.media_item_id,
        last_error: enrichmentJobs.last_error,
        updated_at: enrichmentJobs.updated_at,
      })
      .from(enrichmentJobs)
      .where(eq(enrichmentJobs.status, 'failed'))
      .orderBy(desc(enrichmentJobs.updated_at))
      .limit(5)

    stats.recentFailed = recentFailed.map((r) => ({
      id: r.id,
      mediaItemId: r.media_item_id,
      lastError: r.last_error,
      updatedAt: r.updated_at,
    }))

    return stats
  }

  async clearCompleted(db: DrizzleDB): Promise<number> {
    const rows = await db
      .select({ id: enrichmentJobs.id })
      .from(enrichmentJobs)
      .where(or(eq(enrichmentJobs.status, 'done'), eq(enrichmentJobs.status, 'failed')))

    if (rows.length === 0) return 0

    await db
      .delete(enrichmentJobs)
      .where(or(eq(enrichmentJobs.status, 'done'), eq(enrichmentJobs.status, 'failed')))

    return rows.length
  }

  // Process one pending job. Returns true if a job was processed, false if queue was empty.
  // Public so tests can drive processing without starting the loop.
  async processOne(db: DrizzleDB): Promise<boolean> {
    const [job] = await db
      .select()
      .from(enrichmentJobs)
      .where(eq(enrichmentJobs.status, 'pending'))
      .orderBy(asc(enrichmentJobs.created_at))
      .limit(1)

    if (!job) return false

    const now = Date.now()
    await db
      .update(enrichmentJobs)
      .set({ status: 'running', updated_at: now })
      .where(eq(enrichmentJobs.id, job.id))

    try {
      const result = await enrichMediaItem(db, job.media_item_id)
      const done = Date.now()

      if (result.status === 'error') {
        const newAttempts = job.attempts + 1
        const terminal = newAttempts >= job.max_attempts
        await db
          .update(enrichmentJobs)
          .set({
            status: terminal ? 'failed' : 'pending',
            attempts: newAttempts,
            last_error: result.error ?? 'Unknown error',
            updated_at: done,
          })
          .where(eq(enrichmentJobs.id, job.id))
      } else if (DONE_STATUSES.has(result.status)) {
        await db
          .update(enrichmentJobs)
          .set({
            status: 'done',
            attempts: job.attempts + 1,
            last_error: null,
            updated_at: done,
          })
          .where(eq(enrichmentJobs.id, job.id))
      } else {
        // Unknown status — treat as done
        await db
          .update(enrichmentJobs)
          .set({ status: 'done', attempts: job.attempts + 1, updated_at: done })
          .where(eq(enrichmentJobs.id, job.id))
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      const newAttempts = job.attempts + 1
      const terminal = newAttempts >= job.max_attempts
      await db
        .update(enrichmentJobs)
        .set({
          status: terminal ? 'failed' : 'pending',
          attempts: newAttempts,
          last_error: errMsg,
          updated_at: Date.now(),
        })
        .where(eq(enrichmentJobs.id, job.id))
      logger.warn({ err: e, jobId: job.id, mediaItemId: job.media_item_id }, 'Enrichment job failed')
    }

    return true
  }

  private scheduleLoop(): void {
    if (!this.active) return
    this.runOnce().then((hadWork) => {
      if (!this.active) return
      setTimeout(() => this.scheduleLoop(), hadWork ? 0 : POLL_INTERVAL_MS)
    }).catch(() => {
      if (!this.active) return
      setTimeout(() => this.scheduleLoop(), POLL_INTERVAL_MS)
    })
  }

  private async runOnce(): Promise<boolean> {
    if (!this.db) return false
    return this.processOne(this.db)
  }

  private schedulePeriodicEnqueue(): void {
    if (!this.active) return
    this.periodicTimer = setTimeout(async () => {
      if (!this.active || !this.db) return
      try {
        const n = await this.enqueueAll(this.db)
        if (n > 0) logger.info({ enqueued: n }, 'Periodic enrichment enqueue')
      } catch { /* ignore — loop will retry next interval */ }
      this.schedulePeriodicEnqueue()
    }, config.enrichmentPeriodicIntervalMs)
  }
}

export const enrichmentQueue = new EnrichmentQueue()
