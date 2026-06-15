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

// ─── Best-resume merge (Automatic Progress Merge v1) ──────────────────────────
//
// Selects a single "best resume" candidate across local progress, per-user
// remote progress, and node-aggregate remote progress. Automatic *candidate
// selection* only — it never mutates progress. Applying the result is always
// user-initiated. Kept in sync with the backend mirror.
//
// Security: pure. Output contains only safe scalars + enum labels — never a
// viewer hash, user ID, username, email, token, path, URL, or raw error.

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

export function deriveBestResume(
  local: ProgressSnapshot | null,
  remoteUser: RemoteInput,
  remoteNode: RemoteInput
): BestResumeResult {
  const userEval = deriveRemoteProgressSuggestion(local, remoteUser)
  const nodeEval = deriveRemoteProgressSuggestion(local, remoteNode)

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

// ─── Resume recommendation copy (UI text) ─────────────────────────────────────
//
// Pure mapping from a BestResumeResult to operator/user-facing copy. Frontend
// only. Returns only static strings + a formatted position label — never any
// sensitive field.

export interface ResumeRecommendationCopy {
  headline: string
  cta: string | null
  sublabel: string | null
}

function formatPositionLabel(positionSeconds: number | null): string | null {
  if (positionSeconds === null || !isFinite(positionSeconds) || positionSeconds < 0) return null
  const mins = Math.floor(positionSeconds / 60)
  const secs = Math.round(positionSeconds % 60)
  return `Resume from ${mins}m ${secs}s`
}

export function resumeRecommendationCopy(best: BestResumeResult): ResumeRecommendationCopy {
  const sublabel = formatPositionLabel(best.positionSeconds)
  switch (best.source) {
    case 'remote_user':
      return {
        headline: 'Resume from your progress on this Trusted Home',
        cta: 'Resume from remote progress',
        sublabel,
      }
    case 'remote_node':
      return {
        headline: 'Progress from this Trusted Home is available',
        cta: 'Resume from remote progress',
        sublabel,
      }
    case 'local':
      return {
        headline: 'Resume from where you left off',
        cta: null,
        sublabel,
      }
    case 'none':
    default:
      return { headline: '', cta: null, sublabel: null }
  }
}
