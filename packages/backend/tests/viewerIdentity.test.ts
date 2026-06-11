/**
 * Per-User Viewer Identity — pure unit tests
 *
 * Covers:
 *   Hash derivation (6 tests)
 *   Hash validation (4 tests)
 *   Secret resolver stability (2 tests)
 *
 * Total: 12 tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  deriveViewerIdentityHash,
  isValidViewerIdentityHash,
} from '../src/services/federation/viewerIdentity'

// ─── Hash derivation ──────────────────────────────────────────────────────────

describe('deriveViewerIdentityHash', () => {
  const secret = 'test-viewer-identity-secret'
  const nodeId = 'node-abc'
  const userId = 'user-xyz'

  it('returns 32 lowercase hex characters', () => {
    const hash = deriveViewerIdentityHash(secret, nodeId, userId)
    expect(hash).toMatch(/^[a-f0-9]{32}$/)
  })

  it('is stable for the same (secret, nodeId, userId)', () => {
    const a = deriveViewerIdentityHash(secret, nodeId, userId)
    const b = deriveViewerIdentityHash(secret, nodeId, userId)
    expect(a).toBe(b)
  })

  it('differs across users', () => {
    const a = deriveViewerIdentityHash(secret, nodeId, 'user-one')
    const b = deriveViewerIdentityHash(secret, nodeId, 'user-two')
    expect(a).not.toBe(b)
  })

  it('differs across nodes', () => {
    const a = deriveViewerIdentityHash(secret, 'node-A', userId)
    const b = deriveViewerIdentityHash(secret, 'node-B', userId)
    expect(a).not.toBe(b)
  })

  it('differs across secrets', () => {
    const a = deriveViewerIdentityHash('secret-one', nodeId, userId)
    const b = deriveViewerIdentityHash('secret-two', nodeId, userId)
    expect(a).not.toBe(b)
  })

  it('does not equal the raw userId', () => {
    const hash = deriveViewerIdentityHash(secret, nodeId, userId)
    expect(hash).not.toBe(userId)
    expect(hash).not.toContain(userId)
  })
})

// ─── Hash validation ──────────────────────────────────────────────────────────

describe('isValidViewerIdentityHash', () => {
  it('accepts a valid 32-char lowercase hex string', () => {
    expect(isValidViewerIdentityHash('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(true)
  })

  it('rejects uppercase hex', () => {
    expect(isValidViewerIdentityHash('A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4')).toBe(false)
  })

  it('rejects wrong length', () => {
    expect(isValidViewerIdentityHash('a1b2c3d4')).toBe(false)
    expect(isValidViewerIdentityHash('a'.repeat(33))).toBe(false)
  })

  it('rejects non-hex and non-string values', () => {
    expect(isValidViewerIdentityHash('not-a-hex-string!!!!!!!!!!!!!!!!!')).toBe(false)
    expect(isValidViewerIdentityHash(null)).toBe(false)
    expect(isValidViewerIdentityHash(undefined)).toBe(false)
    expect(isValidViewerIdentityHash(123)).toBe(false)
  })
})

// ─── Secret resolver stability ────────────────────────────────────────────────

describe('resolveViewerIdentitySecret stability', () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    // Restore env
    Object.keys(process.env).forEach((k) => {
      if (!(k in origEnv)) delete process.env[k]
      else process.env[k] = origEnv[k]
    })
  })

  it('is stable when MEDIA_TOKEN_SECRET is set and TRUSTED_HOME_VIEWER_IDENTITY_SECRET is absent', async () => {
    delete process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET
    process.env.MEDIA_TOKEN_SECRET = 'stable-media-token-secret'
    process.env.NODE_ENV = 'test'

    // Import fresh to pick up env; use dynamic import to avoid module cache pollution
    // across other tests — we just re-call the exported function.
    const { resolveViewerIdentitySecret } = await import('../src/config')
    const first = resolveViewerIdentitySecret()
    const second = resolveViewerIdentitySecret()
    expect(first).toBe(second)
    expect(first.length).toBeGreaterThan(0)
  })

  it('derived secret differs from the raw MEDIA_TOKEN_SECRET (domain-separated)', async () => {
    const rawSecret = 'stable-media-token-secret-for-domain-sep'
    delete process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET
    process.env.MEDIA_TOKEN_SECRET = rawSecret
    process.env.NODE_ENV = 'test'

    const { resolveViewerIdentitySecret } = await import('../src/config')
    const derived = resolveViewerIdentitySecret()
    expect(derived).not.toBe(rawSecret)
  })
})
