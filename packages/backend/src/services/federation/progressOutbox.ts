import { eq, and } from 'drizzle-orm'
import { federatedProgressOutbox } from '../../db/schema'
import type { DrizzleDB } from '../../db/client'
import { recordAuditEvent } from './auditEvents'

// ─── Enqueue / upsert ─────────────────────────────────────────────────────────
//
// Inserts or updates a federated progress push job in the outbox.
//
// Upsert rules (on unique constraint: node_id + media_id + client_event_id):
//   - Only update payload if incoming local_updated_at is NEWER than stored.
//   - If existing status is 'synced' or 'abandoned': reset to 'pending'
//     (newer progress supersedes a completed or abandoned job).
//   - If existing status is 'pending' or 'failed': update payload,
//     reset attempt_count=0, next_attempt_at=now, status='pending'.
//   - If existing status is 'in_progress': update payload fields only,
//     leave status/attempt_count for the worker to handle on its next attempt.
//   - New jobs: status='pending', attempt_count=0, next_attempt_at=now.
//
// NEVER stores: user_id, federation token, raw URL, username, email,
// filesystem path, Authorization header, raw error body, or stack trace.

export async function enqueueProgressPush(
  db: DrizzleDB,
  opts: {
    nodeId: string
    mediaId: string
    clientEventId: string
    positionSeconds: number
    durationSeconds: number | null
    watched: boolean
    localUpdatedAt: string
  }
): Promise<void> {
  const { nodeId, mediaId, clientEventId, positionSeconds, durationSeconds, watched, localUpdatedAt } = opts
  const now = new Date().toISOString()

  // Check for an existing row
  const [existing] = await db
    .select()
    .from(federatedProgressOutbox)
    .where(
      and(
        eq(federatedProgressOutbox.node_id, nodeId),
        eq(federatedProgressOutbox.media_id, mediaId),
        eq(federatedProgressOutbox.client_event_id, clientEventId)
      )
    )
    .limit(1)

  if (!existing) {
    // New job — insert immediately
    await db.insert(federatedProgressOutbox).values({
      id: crypto.randomUUID(),
      node_id: nodeId,
      media_id: mediaId,
      client_event_id: clientEventId,
      position_seconds: positionSeconds,
      duration_seconds: durationSeconds,
      watched: watched ? 1 : 0,
      local_updated_at: localUpdatedAt,
      attempt_count: 0,
      max_attempts: 3,
      status: 'pending',
      next_attempt_at: now,
      last_attempt_at: null,
      last_error_code: null,
      created_at: now,
      updated_at: now,
    })
    recordAuditEvent(db, { action: 'progress_push_enqueued', result: 'success', reasonCode: 'push_accepted', nodeId })
    return
  }

  // Existing row — only update payload if incoming timestamp is newer
  if (localUpdatedAt <= existing.local_updated_at) {
    // Stale — do not overwrite with older progress
    return
  }

  const currentStatus = existing.status

  if (currentStatus === 'in_progress') {
    // Worker has this job locked — update payload only, leave status/attempt_count
    await db
      .update(federatedProgressOutbox)
      .set({
        position_seconds: positionSeconds,
        duration_seconds: durationSeconds,
        watched: watched ? 1 : 0,
        local_updated_at: localUpdatedAt,
        updated_at: now,
      })
      .where(eq(federatedProgressOutbox.id, existing.id))
    return
  }

  // For 'pending', 'failed', 'synced', 'abandoned' — reset to pending with fresh payload
  await db
    .update(federatedProgressOutbox)
    .set({
      position_seconds: positionSeconds,
      duration_seconds: durationSeconds,
      watched: watched ? 1 : 0,
      local_updated_at: localUpdatedAt,
      attempt_count: 0,
      status: 'pending',
      next_attempt_at: now,
      updated_at: now,
    })
    .where(eq(federatedProgressOutbox.id, existing.id))
  recordAuditEvent(db, { action: 'progress_push_enqueued', result: 'success', reasonCode: 'push_accepted', nodeId })
}
