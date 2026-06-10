/**
 * Tests for progressPushStatusLabel — progress push status → display copy mapping.
 *
 * Frontend tests added for Durable Federated Progress Push Outbox v1.
 *
 * Covers:
 *   - 'pending' renders "Progress sync pending"
 *   - 'abandoned' / 'failed' renders "Progress sync unavailable" (no raw error)
 *   - Playback-neutral: outbox status values never include raw error detail
 */

import { describe, it, expect } from 'vitest'
import { progressPushStatusLabel } from './progressPushStatusLabel'

describe('progressPushStatusLabel', () => {
  it("null status renders 'Progress stored locally'", () => {
    expect(progressPushStatusLabel(null)).toBe('Progress stored locally')
  })

  it("undefined status renders 'Progress stored locally'", () => {
    expect(progressPushStatusLabel(undefined)).toBe('Progress stored locally')
  })

  it("'not_enabled' renders 'Progress stored locally'", () => {
    expect(progressPushStatusLabel('not_enabled')).toBe('Progress stored locally')
  })

  it("'pending' renders 'Progress sync pending'", () => {
    expect(progressPushStatusLabel('pending')).toBe('Progress sync pending')
  })

  it("'synced' renders 'Progress synced'", () => {
    expect(progressPushStatusLabel('synced')).toBe('Progress synced')
  })

  it("'failed' renders 'Progress sync unavailable' — no raw error detail", () => {
    const label = progressPushStatusLabel('failed')
    expect(label).toBe('Progress sync unavailable')
    // Must never include raw error codes, node IDs, tokens, or paths
    expect(label).not.toContain('ECONNREFUSED')
    expect(label).not.toContain('node')
    expect(label).not.toContain('token')
  })

  it("'abandoned' renders 'Progress sync unavailable' — no raw error detail", () => {
    const label = progressPushStatusLabel('abandoned')
    expect(label).toBe('Progress sync unavailable')
    expect(label).not.toContain('attempt')
    expect(label).not.toContain('error')
  })

  it("'source_unavailable' renders 'Progress sync unavailable'", () => {
    expect(progressPushStatusLabel('source_unavailable')).toBe('Progress sync unavailable')
  })

  it('unknown status returns null (caller renders nothing — no raw error surfaced)', () => {
    expect(progressPushStatusLabel('some_unknown_future_status')).toBeNull()
    // Crucially: null means the component renders nothing, not a raw error string
  })

  it('all known non-error states return a non-null string (display always covered)', () => {
    const knownStatuses = [null, undefined, 'not_enabled', 'pending', 'synced', 'failed', 'abandoned', 'source_unavailable'] as const
    for (const status of knownStatuses) {
      expect(progressPushStatusLabel(status)).not.toBeNull()
    }
  })
})
