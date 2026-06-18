/**
 * Trusted Home smoke harness — self-test.
 *
 * Runs the deterministic smoke harness and asserts every check passes and the
 * no-leak scan is clean. This keeps the harness honest in CI.
 */

import { describe, it, expect } from 'vitest'
import { runTrustedHomeSmoke } from '../src/services/federation/trustedHomeSmoke'

describe('Trusted Home smoke harness', () => {
  it('passes every federation check with no sensitive leakage', async () => {
    const report = await runTrustedHomeSmoke()

    // Surface any failing check name in the assertion message.
    const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)
    expect(failed, failed.join(' | ')).toHaveLength(0)
    expect(report.ok).toBe(true)
    expect(report.leak.clean).toBe(true)
    expect(report.leak.scanned).toBeGreaterThan(0)

    // Core checklist coverage is present.
    const names = report.checks.map((c) => c.name)
    expect(names).toContain('readiness_health')
    expect(names).toContain('per_user_bilateral_push')
    expect(names).toContain('one_sided_user_read_no_aggregate_fallback')
    expect(names).toContain('viewer_proxy_read_and_resume_suggestion')
    expect(names).toContain('no_sensitive_leak')
  }, 30000)
})
