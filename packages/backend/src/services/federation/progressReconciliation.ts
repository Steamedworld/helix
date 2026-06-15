/**
 * progressReconciliation.ts
 *
 * Pure reconciliation helper for federated watch progress.
 * Derives a suggestion about whether to use remote progress vs keep local.
 *
 * Security rules:
 *   - Pure function — no DB access, no network calls.
 *   - MUST NOT auto-overwrite local progress. The caller must present the
 *     suggestion to the user. Applying it is always user-initiated.
 *   - MUST NOT include viewer hash, user IDs, paths, or credentials.
 */

export interface ProgressSnapshot {
  positionSeconds: number
  durationSeconds: number | null
  watched: boolean
  updatedAt: string | null // ISO8601
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

/**
 * Derive a safe suggestion for whether to use remote progress or keep local.
 *
 * Rules (in order):
 *  1. No remote → no_suggestion / no_remote
 *  2. Missing critical data → no_suggestion / missing_data
 *  3. Remote position overruns duration (> 1.01×) → no_suggestion / invalid_overrun
 *  4. Remote watched=true but < 85% complete → no_suggestion / invalid_threshold
 *  5. Duration mismatch > 10% → no_suggestion / duration_mismatch
 *  6. Remote updatedAt is older than local updatedAt → no_suggestion / remote_older
 *  7. Remote is stale (> 7 days old) → no_suggestion / stale_remote
 *  8. No local progress → use any valid remote → use_remote / remote_meaningfully_ahead
 *  9. Difference < 30s AND < 5% of duration → no_suggestion / tiny_difference
 * 10. Remote ahead by >= 60s AND >= 5% of duration → use_remote / remote_meaningfully_ahead
 * 11. Otherwise: keep_local / local_wins
 */
export function deriveRemoteProgressSuggestion(
  local: ProgressSnapshot | null,
  remote: RemoteInput
): ReconciliationResult {
  // 1. No remote
  if (!isProgressSnapshot(remote)) {
    return { suggestion: 'no_suggestion', reason: 'no_remote' }
  }

  // 2. Missing critical data
  if (remote.durationSeconds === null || remote.updatedAt === null) {
    return { suggestion: 'no_suggestion', reason: 'missing_data' }
  }

  const remoteDuration = remote.durationSeconds

  // 3. Invalid overrun: positionSeconds > durationSeconds * 1.01
  if (remote.positionSeconds > remoteDuration * 1.01) {
    return { suggestion: 'no_suggestion', reason: 'invalid_overrun' }
  }

  // 4. Invalid watched threshold: watched=true but < 85% complete
  if (remote.watched && remote.positionSeconds < remoteDuration * 0.85) {
    return { suggestion: 'no_suggestion', reason: 'invalid_threshold' }
  }

  // 5. Duration mismatch > 10%
  if (local !== null && local.durationSeconds !== null) {
    const localDuration = local.durationSeconds
    const maxDuration = Math.max(localDuration, remoteDuration)
    if (maxDuration > 0) {
      const mismatchRatio = Math.abs(localDuration - remoteDuration) / maxDuration
      if (mismatchRatio > 0.1) {
        return { suggestion: 'no_suggestion', reason: 'duration_mismatch' }
      }
    }
  }

  // 6. Remote updatedAt older than local updatedAt
  if (local !== null && local.updatedAt !== null) {
    const localUpdated = new Date(local.updatedAt).getTime()
    const remoteUpdated = new Date(remote.updatedAt).getTime()
    if (!isNaN(localUpdated) && !isNaN(remoteUpdated) && remoteUpdated < localUpdated) {
      return { suggestion: 'no_suggestion', reason: 'remote_older' }
    }
  }

  // 7. Remote stale > 7 days
  const remoteUpdatedMs = new Date(remote.updatedAt).getTime()
  if (!isNaN(remoteUpdatedMs)) {
    const ageMs = Date.now() - remoteUpdatedMs
    if (ageMs > 7 * 24 * 60 * 60 * 1000) {
      return { suggestion: 'no_suggestion', reason: 'stale_remote' }
    }
  }

  // 8. No local progress → use any valid remote
  if (local === null) {
    return { suggestion: 'use_remote', reason: 'remote_meaningfully_ahead' }
  }

  // 9–10. Difference checks — use duration for percentage calculation
  const durationForPct = remoteDuration > 0 ? remoteDuration : (local.durationSeconds ?? remoteDuration)
  const delta = remote.positionSeconds - local.positionSeconds
  const pct = durationForPct > 0 ? delta / durationForPct : 0

  // 9. Tiny difference: < 30s AND < 5%
  if (Math.abs(delta) < 30 && Math.abs(pct) < 0.05) {
    return { suggestion: 'no_suggestion', reason: 'tiny_difference' }
  }

  // 10. Remote meaningfully ahead: >= 60s AND >= 5%
  if (delta >= 60 && pct >= 0.05) {
    return { suggestion: 'use_remote', reason: 'remote_meaningfully_ahead' }
  }

  // 11. Otherwise: keep local
  return { suggestion: 'keep_local', reason: 'local_wins' }
}

// ─── Best-resume merge (Automatic Progress Merge v1) ──────────────────────────
//
// Selects a single "best resume" candidate across local progress, per-user
// remote progress, and node-aggregate remote progress. This is automatic
// *candidate selection* only — it never mutates any progress. Applying the
// result is always user-initiated.
//
// Security: pure function. Output contains only safe scalars (position,
// duration, watched, updatedAt) and enum labels — never a viewer hash, user
// ID, username, email, token, path, URL, raw error, or debug internal.

export type ResumeSource = 'local' | 'remote_user' | 'remote_node' | 'none'
export type ResumeAction = 'use_local' | 'suggest_remote' | 'no_progress'
export type ResumeConfidence = 'high' | 'medium' | 'low'
export type ResumeReasonCode = ReconciliationResult['reason'] | 'no_progress'

export interface BestResumeResult {
  source: ResumeSource
  action: ResumeAction
  positionSeconds: number | null
  durationSeconds: number | null
  watched: boolean
  updatedAt: string | null
  reasonCode: ResumeReasonCode
  confidence: ResumeConfidence
}

/**
 * Derive the single best resume candidate.
 *
 * Precedence:
 *   1. A valid, meaningfully-ahead per-user remote → suggest remote_user (high).
 *   2. Node aggregate, ONLY when no meaningful per-user candidate exists and the
 *      aggregate is clearly ahead → suggest remote_node (medium). A present and
 *      valid per-user candidate always blocks the node-aggregate fallback — a
 *      per-user scope must never be silently replaced by a household aggregate.
 *   3. Local progress present → use_local (high).
 *   4. Nothing usable → no_progress (low).
 *
 * All threshold logic (overrun, watched %, duration mismatch, staleness, tiny
 * differences, meaningfully-ahead) is delegated to deriveRemoteProgressSuggestion
 * so the conservative rules stay in one place.
 */
export function deriveBestResume(
  local: ProgressSnapshot | null,
  remoteUser: RemoteInput,
  remoteNode: RemoteInput
): BestResumeResult {
  const userEval = deriveRemoteProgressSuggestion(local, remoteUser)
  const nodeEval = deriveRemoteProgressSuggestion(local, remoteNode)

  // A per-user candidate is "meaningful" if it is present and its data is valid
  // (not rejected as malformed/missing). Only a non-meaningful (absent or
  // malformed) per-user candidate permits a node-aggregate fallback.
  const userDataInvalid =
    userEval.reason === 'no_remote' ||
    userEval.reason === 'missing_data' ||
    userEval.reason === 'invalid_overrun' ||
    userEval.reason === 'invalid_threshold'
  const userMeaningful = isProgressSnapshot(remoteUser) && !userDataInvalid

  // 1. Valid, meaningfully-ahead per-user remote.
  if (userEval.suggestion === 'use_remote' && isProgressSnapshot(remoteUser)) {
    return {
      source: 'remote_user',
      action: 'suggest_remote',
      positionSeconds: remoteUser.positionSeconds,
      durationSeconds: remoteUser.durationSeconds,
      watched: remoteUser.watched,
      updatedAt: remoteUser.updatedAt,
      reasonCode: userEval.reason,
      confidence: 'high',
    }
  }

  // 2. Node aggregate — only when no meaningful per-user candidate exists.
  if (!userMeaningful && nodeEval.suggestion === 'use_remote' && isProgressSnapshot(remoteNode)) {
    return {
      source: 'remote_node',
      action: 'suggest_remote',
      positionSeconds: remoteNode.positionSeconds,
      durationSeconds: remoteNode.durationSeconds,
      watched: remoteNode.watched,
      updatedAt: remoteNode.updatedAt,
      reasonCode: nodeEval.reason,
      confidence: 'medium',
    }
  }

  // 3. Keep local.
  if (local !== null) {
    const reason: ResumeReasonCode = isProgressSnapshot(remoteUser)
      ? userEval.reason
      : isProgressSnapshot(remoteNode)
        ? nodeEval.reason
        : 'no_remote'
    return {
      source: 'local',
      action: 'use_local',
      positionSeconds: local.positionSeconds,
      durationSeconds: local.durationSeconds,
      watched: local.watched,
      updatedAt: local.updatedAt,
      reasonCode: reason,
      confidence: 'high',
    }
  }

  // 4. Nothing usable.
  return {
    source: 'none',
    action: 'no_progress',
    positionSeconds: null,
    durationSeconds: null,
    watched: false,
    updatedAt: null,
    reasonCode: 'no_progress',
    confidence: 'low',
  }
}
