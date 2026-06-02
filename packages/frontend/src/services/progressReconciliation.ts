/**
 * progressReconciliation.ts (frontend)
 *
 * Pure reconciliation helper for federated watch progress.
 * Kept in sync with packages/backend/src/services/federation/progressReconciliation.ts.
 *
 * Security: pure function, no network calls, no DB access.
 * MUST NOT auto-overwrite local progress — suggestion is user-initiated only.
 */

export interface ProgressSnapshot {
  positionSeconds: number
  durationSeconds: number | null
  watched: boolean
  updatedAt: string | null
}

export interface ReconciliationResult {
  suggestion: 'use_remote' | 'keep_local' | 'no_suggestion'
  reason:
    | 'remote_meaningfully_ahead'
    | 'local_wins'
    | 'remote_older'
    | 'duration_mismatch'
    | 'invalid_threshold'
    | 'invalid_overrun'
    | 'tiny_difference'
    | 'stale_remote'
    | 'missing_data'
    | 'no_remote'
}

type RemoteInput = ProgressSnapshot | null | { available: false }

function isProgressSnapshot(r: RemoteInput): r is ProgressSnapshot {
  return r !== null && typeof r === 'object' && 'positionSeconds' in r
}

export function deriveRemoteProgressSuggestion(
  local: ProgressSnapshot | null,
  remote: RemoteInput
): ReconciliationResult {
  if (!isProgressSnapshot(remote)) {
    return { suggestion: 'no_suggestion', reason: 'no_remote' }
  }
  if (remote.durationSeconds === null || remote.updatedAt === null) {
    return { suggestion: 'no_suggestion', reason: 'missing_data' }
  }
  const remoteDuration = remote.durationSeconds
  if (remote.positionSeconds > remoteDuration * 1.01) {
    return { suggestion: 'no_suggestion', reason: 'invalid_overrun' }
  }
  if (remote.watched && remote.positionSeconds < remoteDuration * 0.85) {
    return { suggestion: 'no_suggestion', reason: 'invalid_threshold' }
  }
  if (local !== null && local.durationSeconds !== null) {
    const maxDuration = Math.max(local.durationSeconds, remoteDuration)
    if (maxDuration > 0) {
      const mismatchRatio = Math.abs(local.durationSeconds - remoteDuration) / maxDuration
      if (mismatchRatio > 0.1) {
        return { suggestion: 'no_suggestion', reason: 'duration_mismatch' }
      }
    }
  }
  if (local !== null && local.updatedAt !== null) {
    const localUpdated = new Date(local.updatedAt).getTime()
    const remoteUpdated = new Date(remote.updatedAt).getTime()
    if (!isNaN(localUpdated) && !isNaN(remoteUpdated) && remoteUpdated < localUpdated) {
      return { suggestion: 'no_suggestion', reason: 'remote_older' }
    }
  }
  const remoteUpdatedMs = new Date(remote.updatedAt).getTime()
  if (!isNaN(remoteUpdatedMs)) {
    const ageMs = Date.now() - remoteUpdatedMs
    if (ageMs > 7 * 24 * 60 * 60 * 1000) {
      return { suggestion: 'no_suggestion', reason: 'stale_remote' }
    }
  }
  if (local === null) {
    return { suggestion: 'use_remote', reason: 'remote_meaningfully_ahead' }
  }
  const durationForPct = remoteDuration > 0 ? remoteDuration : (local.durationSeconds ?? remoteDuration)
  const delta = remote.positionSeconds - local.positionSeconds
  const pct = durationForPct > 0 ? delta / durationForPct : 0
  if (Math.abs(delta) < 30 && Math.abs(pct) < 0.05) {
    return { suggestion: 'no_suggestion', reason: 'tiny_difference' }
  }
  if (delta >= 60 && pct >= 0.05) {
    return { suggestion: 'use_remote', reason: 'remote_meaningfully_ahead' }
  }
  return { suggestion: 'keep_local', reason: 'local_wins' }
}
