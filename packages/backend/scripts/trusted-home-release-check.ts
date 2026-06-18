/**
 * Trusted Home release candidate gate — CLI wrapper.
 *
 *   pnpm --filter @helix/backend release-check:trusted-home          (full gates)
 *   pnpm --filter @helix/backend release-check:trusted-home --quick  (in-process only)
 *
 * Prints the release checklist and a per-gate ✓/✗ summary, then exits non-zero
 * if any gate failed. Output is safe — no secrets, tokens, hashes, URLs, or paths.
 */

import { runReleaseCheck } from '../src/services/federation/trustedHomeReleaseCheck'

async function main() {
  const quick = process.argv.includes('--quick')
  const report = await runReleaseCheck({ full: !quick })

  process.stdout.write('\nTrusted Home — Release checklist\n')
  report.checklist.forEach((item, i) => process.stdout.write(`  ${i + 1}. ${item}\n`))

  process.stdout.write('\nGates\n')
  for (const g of report.gates) {
    const mark = g.skipped ? '–' : g.ok ? '✓' : '✗'
    process.stdout.write(`  ${mark} ${g.name} — ${g.detail}\n`)
  }

  process.stdout.write(report.ok ? '\nRELEASE CHECK PASS\n' : '\nRELEASE CHECK FAIL\n')
  process.exit(report.ok ? 0 : 1)
}

main().catch((e) => {
  process.stderr.write(`release check crashed: ${(e as Error).message}\n`)
  process.exit(1)
})
