import { eq, and, inArray, lte, lt } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { federatedProgressOutbox, nodes, watchStates, libraries, mediaItems } from '../../db/schema'
import type { DrizzleDB } from '../../db/client'
import { logger } from '../../lib/logger'
import { decryptApiKey } from '../integrations/encryption'
import { classifySyncError } from './syncErrorClassifier'
import { recordAuditEvent } from './auditEvents'

// ─── Config ────────────────────────────────────────────────────────────────────

export interface ProgressOutboxWorkerConfig {
  intervalMs: number
  maxAttempts: number
  requestTimeoutMs: number
  dataDir: string
}

// ─── Backoff schedule ─────────────────────────────────────────────────────────
//
// After attempt N fails, wait this long before the next attempt:
//   attempt 1 → 30 seconds
//   attempt 2 → 120 seconds
//   attempt 3 → final (will be abandoned after failure, no next_attempt_at matters)
//
// ±10% jitter applied to all values.

const BACKOFF_SECONDS = [30, 120]

function backoffMs(attemptCount: number): number {
  const idx = Math.min(attemptCount - 1, BACKOFF_SECONDS.length - 1)
  const base = (BACKOFF_SECONDS[idx] ?? 120) * 1000
  const jitter = base * (0.9 + Math.random() * 0.2)
  return Math.round(jitter)
}

// ─── Worker interface ─────────────────────────────────────────────────────────

export interface ProgressOutboxWorker {
  start(): void
  stop(): Promise<void>
}

// ─── Worker factory ───────────────────────────────────────────────────────────

export function createProgressOutboxWorker(
  db: DrizzleDB,
  cfg: ProgressOutboxWorkerConfig
): ProgressOutboxWorker {
  let active = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let tickPromise: Promise<void> | null = null

  async function runTick(): Promise<void> {
    const now = new Date().toISOString()

    // Query up to 20 jobs ready for processing
    let jobs: Array<typeof federatedProgressOutbox.$inferSelect>
    try {
      jobs = await db
        .select()
        .from(federatedProgressOutbox)
        .where(
          and(
            inArray(federatedProgressOutbox.status, ['pending', 'failed']),
            lte(federatedProgressOutbox.next_attempt_at, now),
            lt(federatedProgressOutbox.attempt_count, federatedProgressOutbox.max_attempts)
          )
        )
        .orderBy(federatedProgressOutbox.next_attempt_at)
        .limit(20)
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : String(e) }, '[progressOutbox] Failed to query jobs')
      return
    }

    for (const job of jobs) {
      if (!active) break

      // Per-job catch — one failure must not stop the loop
      try {
        await processJob(db, cfg, job)
      } catch (e) {
        // Unexpected error outside the normal job flow — log safe code only
        const classified = classifySyncError(e)
        logger.warn(
          { code: classified.code, jobId: job.id, nodeId: job.node_id },
          '[progressOutbox] Unexpected error processing job'
        )
        // Best-effort: mark failed so we retry
        try {
          const newAttemptCount = job.attempt_count + 1
          const nowTs = new Date().toISOString()
          if (newAttemptCount >= job.max_attempts) {
            await db
              .update(federatedProgressOutbox)
              .set({
                status: 'abandoned',
                attempt_count: newAttemptCount,
                last_attempt_at: nowTs,
                last_error_code: classified.code,
                updated_at: nowTs,
              })
              .where(eq(federatedProgressOutbox.id, job.id))
          } else {
            await db
              .update(federatedProgressOutbox)
              .set({
                status: 'failed',
                attempt_count: newAttemptCount,
                last_attempt_at: nowTs,
                last_error_code: classified.code,
                next_attempt_at: new Date(Date.now() + backoffMs(newAttemptCount)).toISOString(),
                updated_at: nowTs,
              })
              .where(eq(federatedProgressOutbox.id, job.id))
          }
        } catch {
          // Best-effort DB update — ignore secondary failure
        }
      }
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
    }, cfg.intervalMs)
  }

  return {
    start(): void {
      if (active) return
      active = true
      // Fire immediately on start, then schedule recurring ticks
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
      // Wait for any in-flight tick to drain
      if (tickPromise) {
        await tickPromise.catch(() => {})
        tickPromise = null
      }
    },
  }
}

// ─── Per-job processing ───────────────────────────────────────────────────────

async function processJob(
  db: DrizzleDB,
  cfg: ProgressOutboxWorkerConfig,
  job: typeof federatedProgressOutbox.$inferSelect
): Promise<void> {
  const nowTs = new Date().toISOString()

  // Mark as in_progress
  await db
    .update(federatedProgressOutbox)
    .set({ status: 'in_progress', last_attempt_at: nowTs, updated_at: nowTs })
    .where(eq(federatedProgressOutbox.id, job.id))

  // Load node record — check it still exists and has push enabled
  const [node] = await db
    .select()
    .from(nodes)
    .where(eq(nodes.id, job.node_id))
    .limit(1)

  if (!node) {
    // Node was deleted — ON DELETE CASCADE will clean up the outbox row,
    // but in case we race, just mark abandoned
    await db
      .update(federatedProgressOutbox)
      .set({
        status: 'abandoned',
        attempt_count: job.attempt_count + 1,
        last_error_code: 'config_disabled',
        updated_at: new Date().toISOString(),
      })
      .where(eq(federatedProgressOutbox.id, job.id))
    recordAuditEvent(db, { action: 'progress_push_abandoned', result: 'error', reasonCode: 'push_abandoned_config_disabled', nodeId: job.node_id })
    return
  }

  if (!node.progress_sync_enabled || !node.allow_progress_push) {
    // Config changed — abandon immediately
    await db
      .update(federatedProgressOutbox)
      .set({
        status: 'abandoned',
        attempt_count: job.attempt_count + 1,
        last_error_code: 'config_disabled',
        last_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(eq(federatedProgressOutbox.id, job.id))
    recordAuditEvent(db, { action: 'progress_push_abandoned', result: 'error', reasonCode: 'push_abandoned_config_disabled', nodeId: job.node_id })
    return
  }

  if (!node.api_token_encrypted || !node.base_url) {
    await markJobResult(db, job, job.attempt_count + 1, 'auth_failed')
    return
  }

  // Decrypt federation token (server-side only — never logged or returned)
  let rawToken: string
  try {
    rawToken = decryptApiKey(node.api_token_encrypted, cfg.dataDir)
  } catch {
    await markJobResult(db, job, job.attempt_count + 1, 'auth_failed')
    return
  }

  // Build URL from DB-stored base_url only — no user-supplied input
  const upstreamUrl = `${node.base_url}/api/v1/federation/media/${job.media_id}/watch-progress`

  // Per-user viewer identity (user_v1) — forward the stored opaque hash only when present.
  // The hash is carried in the PUT body (server-to-server). Never logged or audited.
  const body = JSON.stringify({
    positionSeconds: job.position_seconds,
    durationSeconds: job.duration_seconds ?? undefined,
    watched: job.watched === 1,
    updatedAt: job.local_updated_at,
    clientEventId: job.client_event_id,
    ...(job.viewer_identity_hash
      ? { viewerIdentity: { kind: 'user', version: 'v1', hash: job.viewer_identity_hash } }
      : {}),
  })

  let res: Response
  try {
    res = await fetch(upstreamUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rawToken}`,
      },
      body,
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    })
  } catch (fetchErr) {
    const classified = classifySyncError(fetchErr)
    await markJobResult(db, job, job.attempt_count + 1, classified.code)
    // Also update the local watch_states row (best-effort)
    await updateLocalWatchStatePushStatus(db, job, 'failed', classified.code)
    return
  }

  const newAttemptCount = job.attempt_count + 1

  if (res.ok) {
    const finishedAt = new Date().toISOString()
    await db
      .update(federatedProgressOutbox)
      .set({
        status: 'synced',
        attempt_count: newAttemptCount,
        last_attempt_at: finishedAt,
        last_error_code: null,
        updated_at: finishedAt,
      })
      .where(eq(federatedProgressOutbox.id, job.id))
    // Update the local watch_states row to 'synced' (best-effort)
    await updateLocalWatchStatePushStatus(db, job, 'synced', null)
    recordAuditEvent(db, { action: 'progress_push_synced', result: 'success', reasonCode: 'push_synced', nodeId: job.node_id })
    logger.info({ nodeId: job.node_id, mediaId: job.media_id }, '[progressOutbox] Push synced')
  } else {
    const classified = classifySyncError({ status: res.status })
    await markJobResult(db, job, newAttemptCount, classified.code)
    await updateLocalWatchStatePushStatus(db, job, 'failed', classified.code)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function markJobResult(
  db: DrizzleDB,
  job: typeof federatedProgressOutbox.$inferSelect,
  newAttemptCount: number,
  errorCode: string
): Promise<void> {
  const nowTs = new Date().toISOString()
  if (newAttemptCount >= job.max_attempts) {
    await db
      .update(federatedProgressOutbox)
      .set({
        status: 'abandoned',
        attempt_count: newAttemptCount,
        last_attempt_at: nowTs,
        last_error_code: errorCode,
        updated_at: nowTs,
      })
      .where(eq(federatedProgressOutbox.id, job.id))
    recordAuditEvent(db, { action: 'progress_push_abandoned', result: 'error', reasonCode: 'push_abandoned_max_attempts', nodeId: job.node_id, context: { errorCode } })
  } else {
    await db
      .update(federatedProgressOutbox)
      .set({
        status: 'failed',
        attempt_count: newAttemptCount,
        last_attempt_at: nowTs,
        last_error_code: errorCode,
        next_attempt_at: new Date(Date.now() + backoffMs(newAttemptCount)).toISOString(),
        updated_at: nowTs,
      })
      .where(eq(federatedProgressOutbox.id, job.id))
    recordAuditEvent(db, { action: 'progress_push_failed', result: 'error', reasonCode: 'push_failed', nodeId: job.node_id, context: { errorCode } })
  }
}

/**
 * Best-effort update of the local watch_states progress_push_status.
 *
 * Looks up the watch_states row for (node_id + media_id) join path:
 * watchStates → mediaItems → libraries to find rows belonging to this node.
 *
 * Failure here is non-fatal — the outbox is the source of truth for push status.
 */
async function updateLocalWatchStatePushStatus(
  db: DrizzleDB,
  job: typeof federatedProgressOutbox.$inferSelect,
  status: 'synced' | 'failed',
  errorCode: string | null
): Promise<void> {
  try {
    const nowTs = new Date().toISOString()
    // Find watch_states rows whose media_item_id matches job.media_id
    // and whose media item belongs to the node (via library)
    const rows = await db
      .select({ ws_id: watchStates.id })
      .from(watchStates)
      .innerJoin(mediaItems, eq(watchStates.media_item_id, mediaItems.id))
      .innerJoin(libraries, eq(mediaItems.library_id, libraries.id))
      .where(
        and(
          eq(watchStates.media_item_id, job.media_id),
          eq(libraries.node_id, job.node_id)
        )
      )
    for (const row of rows) {
      await db
        .update(watchStates)
        .set({
          progress_push_status: status,
          progress_push_at: nowTs,
          progress_push_error_code: errorCode,
        })
        .where(eq(watchStates.id, row.ws_id))
    }
  } catch {
    // Best-effort — never throw from here
  }
}
