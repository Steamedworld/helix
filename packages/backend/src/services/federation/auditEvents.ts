import { trustedHomeAuditEvents } from '../../db/schema'
import type { DrizzleDB } from '../../db/client'

// ─── Vocabulary ───────────────────────────────────────────────────────────────

export type AuditAction =
  | 'trusted_home_settings_changed'
  | 'progress_push_enqueued'
  | 'progress_push_synced'
  | 'progress_push_abandoned'
  | 'progress_push_failed'
  | 'remote_progress_read_denied'
  | 'remote_progress_received'
  | 'playback_proxy_attempt'

export type AuditResult = 'success' | 'denied' | 'skipped' | 'error'

export type AuditReasonCode =
  | 'settings_updated'
  | 'push_accepted'
  | 'push_synced'
  | 'push_abandoned_max_attempts'
  | 'push_abandoned_config_disabled'
  | 'push_abandoned_auth_failed'
  | 'push_failed'
  | 'read_denied_no_sync'
  | 'read_denied_no_node'
  | 'progress_received'
  | 'progress_stale_ignored'
  | 'proxy_attempt_success'
  | 'proxy_attempt_failed'

export interface AuditEventInput {
  action: AuditAction
  result: AuditResult
  reasonCode?: AuditReasonCode
  nodeId?: string
  context?: Record<string, string | number | boolean | null>
}

// ─── Recording ────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget audit recording. Best-effort, non-blocking.
 * A write failure here MUST NOT propagate — never call await on this in a
 * way that could bubble exceptions. Primary operations are never affected.
 *
 * MUST NOT be called with: user_id, federation token, remote_viewer_hash,
 * raw URL, filesystem path, Authorization header, raw error body, stack trace,
 * username, email, or credential material.
 */
export function recordAuditEvent(db: DrizzleDB, event: AuditEventInput): void {
  void (async () => {
    try {
      const now = new Date().toISOString()
      await db.insert(trustedHomeAuditEvents).values({
        id: crypto.randomUUID(),
        occurred_at: now,
        action: event.action,
        result: event.result,
        reason_code: event.reasonCode ?? null,
        node_id: event.nodeId ?? null,
        context_json: event.context ? JSON.stringify(event.context) : null,
        created_at: now,
      })
    } catch {
      // Non-fatal — audit failure must never break any primary operation
    }
  })()
}
