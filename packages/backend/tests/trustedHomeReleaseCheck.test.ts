/**
 * Trusted Home release candidate gate — self-test (quick mode).
 *
 * Exercises the in-process gates (smoke harness + docs no-leak scan) and the
 * checklist generation without spawning the heavy shell-out gates.
 */

import { describe, it, expect } from 'vitest'
import { runReleaseCheck, RELEASE_CHECKLIST } from '../src/services/federation/trustedHomeReleaseCheck'

describe('Trusted Home release check (quick mode)', () => {
  it('passes the in-process gates and emits the checklist', async () => {
    const report = await runReleaseCheck({ full: false })

    const byName = Object.fromEntries(report.gates.map((g) => [g.name, g]))
    expect(byName['smoke_harness'].ok).toBe(true)
    expect(byName['docs_no_leak_scan'].ok).toBe(true)

    // Heavy gates are marked skipped (not failed) in quick mode.
    for (const name of ['typecheck', 'lint', 'build', 'backend_tests', 'frontend_tests']) {
      expect(byName[name].skipped).toBe(true)
      expect(byName[name].ok).toBe(true)
    }

    expect(report.ok).toBe(true)
    expect(report.checklist).toBe(RELEASE_CHECKLIST)
    expect(report.checklist.length).toBeGreaterThan(5)
  }, 30000)

  it('checklist text carries no secrets, hashes, URLs, or absolute paths', () => {
    const text = RELEASE_CHECKLIST.join('\n')
    expect(text).not.toMatch(/[a-f0-9]{32,}/i)
    expect(text).not.toMatch(/Bearer\s+\S+/)
    expect(text).not.toMatch(/:\/\/\S+:\S+@/)
    expect(text).not.toMatch(/\/(home|Users)\/[A-Za-z0-9_.-]+\//)
  })
})
