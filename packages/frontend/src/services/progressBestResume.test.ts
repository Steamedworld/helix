/**
 * Automatic Progress Merge v1 — frontend resume selection + copy tests.
 *
 * Covers the decision/copy logic that drives MediaDetail's single resume
 * recommendation: which source wins, what copy is shown, that a remote
 * suggestion is never auto-applied, that a fetch failure leaves playback
 * usable, and that no sensitive data appears in the UI strings.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveBestResume,
  resumeRecommendationCopy,
  type ProgressSnapshot,
} from './progressReconciliation'

function snap(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    positionSeconds: 1800,
    durationSeconds: 7200,
    watched: false,
    updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    ...overrides,
  }
}

describe('resumeRecommendationCopy', () => {
  it('shows local resume copy and no remote CTA for a local recommendation', () => {
    const best = deriveBestResume(snap({ positionSeconds: 3600 }), snap({ positionSeconds: 1200, updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }), null)
    expect(best.source).toBe('local')
    const copy = resumeRecommendationCopy(best)
    expect(copy.headline).toBe('Resume from where you left off')
    expect(copy.cta).toBeNull()
  })

  it('shows per-user remote copy with a resume CTA', () => {
    const best = deriveBestResume(snap({ positionSeconds: 300 }), snap({ positionSeconds: 4200 }), null)
    expect(best.source).toBe('remote_user')
    const copy = resumeRecommendationCopy(best)
    expect(copy.headline).toBe('Resume from your progress on this Trusted Home')
    expect(copy.cta).toBe('Resume from remote progress')
    expect(copy.sublabel).toContain('Resume from')
  })

  it('shows node-aggregate Home-level copy with a resume CTA', () => {
    const best = deriveBestResume(snap({ positionSeconds: 300 }), null, snap({ positionSeconds: 4200 }))
    expect(best.source).toBe('remote_node')
    const copy = resumeRecommendationCopy(best)
    expect(copy.headline).toBe('Progress from this Trusted Home is available')
    expect(copy.cta).toBe('Resume from remote progress')
  })

  it('shows no recommendation (normal play CTA) when there is no progress anywhere', () => {
    const best = deriveBestResume(null, null, null)
    expect(best.action).toBe('no_progress')
    const copy = resumeRecommendationCopy(best)
    expect(copy.headline).toBe('')
    expect(copy.cta).toBeNull()
  })
})

describe('deriveBestResume — safety behavior', () => {
  it('a remote suggestion is a suggestion only (action suggest_remote), never auto-applied', () => {
    const best = deriveBestResume(snap({ positionSeconds: 300 }), snap({ positionSeconds: 4200 }), null)
    expect(best.action).toBe('suggest_remote')
    // The result is a recommendation object; applying it is a separate user action.
  })

  it('does not mutate its inputs (pure)', () => {
    const local = snap({ positionSeconds: 300 })
    const remoteUser = snap({ positionSeconds: 4200 })
    const localCopy = { ...local }
    const remoteCopy = { ...remoteUser }
    deriveBestResume(local, remoteUser, null)
    expect(local).toEqual(localCopy)
    expect(remoteUser).toEqual(remoteCopy)
  })

  it('a failed remote fetch (no remote) leaves local playback usable', () => {
    // MediaDetail sets remote to unavailable on fetch failure → null slots here.
    const best = deriveBestResume(snap({ positionSeconds: 3600 }), null, null)
    expect(best.source).toBe('local')
    expect(best.action).toBe('use_local')
    expect(best.positionSeconds).toBe(3600)
  })

  it('no copy string leaks a hash, token, URL, path, or email', () => {
    const cases = [
      deriveBestResume(snap({ positionSeconds: 300 }), snap({ positionSeconds: 4200 }), null),
      deriveBestResume(snap({ positionSeconds: 300 }), null, snap({ positionSeconds: 4200 })),
      deriveBestResume(snap({ positionSeconds: 3600 }), null, null),
      deriveBestResume(null, null, null),
    ]
    for (const best of cases) {
      const copy = resumeRecommendationCopy(best)
      const text = `${copy.headline}|${copy.cta ?? ''}|${copy.sublabel ?? ''}`
      expect(text).not.toMatch(/[a-f0-9]{32,}/i)
      expect(text).not.toMatch(/Bearer\s/i)
      expect(text).not.toMatch(/:\/\//)
      expect(text).not.toMatch(/\S+@\S+\.\S+/)
    }
  })
})
