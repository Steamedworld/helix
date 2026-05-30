import { computeSyncSafetyEstimate } from './catalogSync'

// ─── Sync health types ────────────────────────────────────────────────────────

export type SyncHealth = 'healthy' | 'never_synced' | 'failing' | 'stale' | 'unknown'

// ─── Single-node classification ───────────────────────────────────────────────

/**
 * Derives the sync health category for a single node.
 *
 * Priority:
 *   1. No attempt and no success → never_synced
 *   2. Active error code set → failing
 *   3. Attempt recorded but no success → unknown
 *   4. Last sync older than tombstone retention window → stale
 *   5. Otherwise → healthy
 */
export function deriveSyncHealth(
  lastSyncAttemptAt: string | null,
  lastSyncAt: number | null,
  lastSyncErrorCode: string | null,
  nextSyncReason: 'no_last_sync' | 'tombstone_retention_exceeded' | 'within_retention',
  _tombstoneRetentionDays: number
): SyncHealth {
  if (!lastSyncAttemptAt && !lastSyncAt) return 'never_synced'
  if (lastSyncErrorCode !== null) return 'failing'
  if (!lastSyncAt) return 'unknown' // attempted but no success recorded
  if (nextSyncReason === 'tombstone_retention_exceeded') return 'stale'
  return 'healthy'
}

// ─── Node shape expected by the rollup ───────────────────────────────────────

export interface SyncHealthNode {
  last_sync_at: number | null
  last_sync_attempt_at: string | null
  last_sync_error_at: string | null
  last_sync_error_code: string | null
  last_sync_error_message: string | null
}

// ─── Aggregate rollup ─────────────────────────────────────────────────────────

export interface SyncHealthRollup {
  total: number
  healthy: number
  failing: number
  stale: number
  neverSynced: number
  unknown: number
  hasFailures: boolean
  /**
   * ISO timestamp of the oldest active error across all failing nodes.
   * "Active" means last_sync_error_code is non-null at the time of this call.
   * null when no nodes are failing.
   */
  oldestActiveErrorAt: string | null
  /**
   * ISO timestamp of the most recent sync attempt across all nodes.
   * null when no node has ever attempted a sync.
   */
  newestAttemptAt: string | null
}

/**
 * Computes an aggregate sync health rollup from a list of trusted-home nodes.
 *
 * This intentionally exposes NO per-node identity — only counts and timestamps.
 * Safe to include in the unauthenticated /health endpoint.
 */
export function computeSyncHealthRollup(
  nodes: SyncHealthNode[],
  tombstoneRetentionDays: number,
  now = new Date()
): SyncHealthRollup {
  let healthy = 0
  let failing = 0
  let stale = 0
  let neverSynced = 0
  let unknown = 0

  let oldestActiveErrorAt: string | null = null
  let newestAttemptAt: string | null = null

  for (const node of nodes) {
    // Convert epoch-ms last_sync_at to ISO string for the safety helper
    const lastSyncIso = node.last_sync_at != null
      ? new Date(node.last_sync_at).toISOString()
      : null

    const safetyEstimate = computeSyncSafetyEstimate(lastSyncIso, tombstoneRetentionDays, now)

    const health = deriveSyncHealth(
      node.last_sync_attempt_at,
      node.last_sync_at,
      node.last_sync_error_code,
      safetyEstimate.nextSyncReason,
      tombstoneRetentionDays
    )

    switch (health) {
      case 'healthy':    healthy++;    break
      case 'failing':    failing++;    break
      case 'stale':      stale++;      break
      case 'never_synced': neverSynced++; break
      case 'unknown':    unknown++;    break
    }

    // Track oldest active error timestamp (only for nodes with an active error code)
    if (node.last_sync_error_code !== null && node.last_sync_error_at !== null) {
      if (oldestActiveErrorAt === null || node.last_sync_error_at < oldestActiveErrorAt) {
        oldestActiveErrorAt = node.last_sync_error_at
      }
    }

    // Track newest attempt timestamp
    if (node.last_sync_attempt_at !== null) {
      if (newestAttemptAt === null || node.last_sync_attempt_at > newestAttemptAt) {
        newestAttemptAt = node.last_sync_attempt_at
      }
    }
  }

  return {
    total: nodes.length,
    healthy,
    failing,
    stale,
    neverSynced,
    unknown,
    hasFailures: failing > 0,
    oldestActiveErrorAt,
    newestAttemptAt,
  }
}
