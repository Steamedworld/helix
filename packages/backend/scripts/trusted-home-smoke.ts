/**
 * Trusted Home federation smoke harness — CLI wrapper.
 *
 * Runs the deterministic, local-first smoke checks and prints a machine-readable
 * JSON report. Exits 0 when every check passes, 1 otherwise. No secrets, no real
 * network, no external services required.
 *
 *   pnpm --filter @helix/backend smoke:trusted-home
 */

import { runTrustedHomeSmoke } from '../src/services/federation/trustedHomeSmoke'

async function main() {
  const report = await runTrustedHomeSmoke()
  // Safe output only — per-check detail carries no secrets, hashes, or paths.
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  for (const c of report.checks) {
    process.stdout.write(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}\n`)
  }
  if (report.skipped.length > 0) {
    process.stdout.write(`skipped: ${report.skipped.join(', ')}\n`)
  }
  process.stdout.write(report.ok ? '\nSMOKE PASS\n' : '\nSMOKE FAIL\n')
  process.exit(report.ok ? 0 : 1)
}

main().catch((e) => {
  process.stderr.write(`smoke harness crashed: ${(e as Error).message}\n`)
  process.exit(1)
})
