/**
 * Unit tests for pickSecretHealthMessage — the pure selector behind the
 * Trusted Home secret-health warnings (playback refresh + viewer identity).
 *
 * These lock in production-readiness copy and guarantee the warnings never
 * leak a secret value, hash, or env var contents.
 */

import { describe, it, expect } from 'vitest'
import { pickSecretHealthMessage, SECRET_HEALTH_MESSAGES } from './Nodes'

describe('pickSecretHealthMessage', () => {
  it('returns null for a healthy explicit secret (no warning shown)', () => {
    expect(pickSecretHealthMessage('explicit_secret', SECRET_HEALTH_MESSAGES.playbackRefresh)).toBeNull()
    expect(pickSecretHealthMessage('explicit_secret', SECRET_HEALTH_MESSAGES.viewerIdentity)).toBeNull()
  })

  it('returns null for an unknown / undefined state', () => {
    expect(pickSecretHealthMessage(undefined, SECRET_HEALTH_MESSAGES.playbackRefresh)).toBeNull()
  })

  it('returns the matching message for each unhealthy state', () => {
    for (const state of ['derived_fallback', 'dev_random', 'missing'] as const) {
      expect(pickSecretHealthMessage(state, SECRET_HEALTH_MESSAGES.playbackRefresh)).toBe(
        SECRET_HEALTH_MESSAGES.playbackRefresh[state]
      )
      expect(pickSecretHealthMessage(state, SECRET_HEALTH_MESSAGES.viewerIdentity)).toBe(
        SECRET_HEALTH_MESSAGES.viewerIdentity[state]
      )
    }
  })

  it('viewer identity messages name the correct env var and resume-stability impact', () => {
    expect(SECRET_HEALTH_MESSAGES.viewerIdentity.derived_fallback).toContain('TRUSTED_HOME_VIEWER_IDENTITY_SECRET')
    expect(SECRET_HEALTH_MESSAGES.viewerIdentity.dev_random).toContain('stable across restarts')
    expect(SECRET_HEALTH_MESSAGES.viewerIdentity.missing).toContain('Production startup will fail')
  })

  it('no message leaks a secret value, hash, or raw env var contents', () => {
    const allMessages = [
      ...Object.values(SECRET_HEALTH_MESSAGES.playbackRefresh),
      ...Object.values(SECRET_HEALTH_MESSAGES.viewerIdentity),
    ]
    for (const msg of allMessages) {
      // Env var NAMES are fine (operator guidance); values/hashes must never appear.
      // A long hex run would indicate a leaked key — assert none is present.
      expect(msg).not.toMatch(/[a-f0-9]{32,}/i)
    }
  })
})
