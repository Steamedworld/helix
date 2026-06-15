/**
 * Automatic Progress Merge v1 — deriveBestResume unit tests
 *
 * Pure best-of(local, remote_user, remote_node) candidate selection. These
 * lock in the conservative precedence and prove the output never carries a
 * sensitive field. Selection only — never mutation.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveBestResume,
  type ProgressSnapshot,
  type BestResumeResult,
} from '../src/services/federation/progressReconciliation'

const DAY = 24 * 60 * 60 * 1000

function snap(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    positionSeconds: 1800,
    durationSeconds: 7200,
    watched: false,
    updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    ...overrides,
  }
}

describe('deriveBestResume', () => {
  it('keeps local when remote is older than local', () => {
    const local = snap({ positionSeconds: 3600, updatedAt: new Date(Date.now() - 1000).toISOString() })
    const remoteUser = snap({ positionSeconds: 5400, updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() })
    const r = deriveBestResume(local, remoteUser, null)
    expect(r.source).toBe('local')
    expect(r.action).toBe('use_local')
    expect(r.reasonCode).toBe('remote_older')
  })

  it('keeps local when remote is only barely ahead (tiny difference)', () => {
    const local = snap({ positionSeconds: 3600 })
    const remoteUser = snap({ positionSeconds: 3610 }) // +10s, < 30s and < 5%
    const r = deriveBestResume(local, remoteUser, null)
    expect(r.source).toBe('local')
    expect(r.reasonCode).toBe('tiny_difference')
  })

  it('keeps local on duration mismatch (different encode)', () => {
    const local = snap({ positionSeconds: 1000, durationSeconds: 7200 })
    // Remote position is valid within its own (shorter) duration, but the
    // durations differ by 50% → duration_mismatch, not overrun.
    const remoteUser = snap({ positionSeconds: 1500, durationSeconds: 3600 })
    const r = deriveBestResume(local, remoteUser, null)
    expect(r.source).toBe('local')
    expect(r.reasonCode).toBe('duration_mismatch')
  })

  it('keeps local when remote position overruns its duration (invalid)', () => {
    const local = snap({ positionSeconds: 1000 })
    const remoteUser = snap({ positionSeconds: 8000, durationSeconds: 7200 }) // > 1.01x
    const r = deriveBestResume(local, remoteUser, null)
    expect(r.source).toBe('local')
    expect(r.reasonCode).toBe('invalid_overrun')
  })

  it('suggests remote_user when valid and meaningfully ahead', () => {
    const local = snap({ positionSeconds: 600 })
    const remoteUser = snap({ positionSeconds: 4200 }) // +3600s, well past thresholds
    const r = deriveBestResume(local, remoteUser, null)
    expect(r.source).toBe('remote_user')
    expect(r.action).toBe('suggest_remote')
    expect(r.confidence).toBe('high')
    expect(r.positionSeconds).toBe(4200)
  })

  it('prefers remote_user over remote_node when both are valid and ahead', () => {
    const local = snap({ positionSeconds: 300 })
    const remoteUser = snap({ positionSeconds: 4200 })
    const remoteNode = snap({ positionSeconds: 6000 }) // node further ahead, but user wins
    const r = deriveBestResume(local, remoteUser, remoteNode)
    expect(r.source).toBe('remote_user')
    expect(r.positionSeconds).toBe(4200)
  })

  it('suggests remote_node only when no valid per-user candidate exists', () => {
    const local = snap({ positionSeconds: 300 })
    const remoteNode = snap({ positionSeconds: 4200 })
    const r = deriveBestResume(local, null, remoteNode)
    expect(r.source).toBe('remote_node')
    expect(r.action).toBe('suggest_remote')
    expect(r.confidence).toBe('medium')
  })

  it('does NOT fall back to remote_node when a valid per-user row exists but is behind local', () => {
    const local = snap({ positionSeconds: 3600, updatedAt: new Date(Date.now() - 1000).toISOString() })
    const remoteUser = snap({ positionSeconds: 1200, updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() })
    const remoteNode = snap({ positionSeconds: 6000 }) // ahead, but must be blocked by the present user row
    const r = deriveBestResume(local, remoteUser, remoteNode)
    expect(r.source).toBe('local')
  })

  it('returns a safe no_progress result when nothing is available', () => {
    const r = deriveBestResume(null, null, null)
    expect(r.source).toBe('none')
    expect(r.action).toBe('no_progress')
    expect(r.positionSeconds).toBeNull()
    expect(r.confidence).toBe('low')
  })

  it('preserves the watched=true threshold (not suggested when < 85% complete)', () => {
    const remoteUser = snap({ positionSeconds: 1000, durationSeconds: 7200, watched: true }) // watched but ~14%
    const r = deriveBestResume(null, remoteUser, null)
    // Invalid watched claim → not suggested; with no local progress → no_progress
    expect(r.action).toBe('no_progress')
    expect(r.source).toBe('none')
  })

  it('output contains only safe scalar/enum fields — no sensitive data', () => {
    const local = snap({ positionSeconds: 300 })
    const remoteUser = snap({ positionSeconds: 4200 })
    const r: BestResumeResult = deriveBestResume(local, remoteUser, null)
    expect(Object.keys(r).sort()).toEqual(
      ['action', 'confidence', 'durationSeconds', 'positionSeconds', 'reasonCode', 'source', 'updatedAt', 'watched'].sort()
    )
    const serialized = JSON.stringify(r)
    // No hash/token-like hex run, no bearer token, no URL, no email address.
    // (Enum labels like "remote_user" are safe and intentionally not flagged.)
    expect(serialized).not.toMatch(/[a-f0-9]{32,}/i)
    expect(serialized).not.toMatch(/Bearer\s/i)
    expect(serialized).not.toMatch(/:\/\//)
    expect(serialized).not.toMatch(/\S+@\S+\.\S+/)
  })
})
