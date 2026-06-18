/**
 * Trusted Home Release Candidate Gate v1.
 *
 * Consolidates the readiness gates for the Trusted Home federation stack into a
 * single command. Runs safe checks only and prints an operator-facing release
 * checklist. Output never contains secrets, tokens, viewer hashes, raw URLs, or
 * media-library paths.
 *
 * In-process gates (always): the deterministic smoke harness + a static no-leak
 * scan of the docs. Heavy gates (typecheck, lint, build, tests) shell out to the
 * existing workspace scripts and run only in `full` mode.
 */

import { spawnSync } from 'child_process'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { runTrustedHomeSmoke } from './trustedHomeSmoke'

export interface ReleaseGate {
  name: string
  ok: boolean
  detail: string
  skipped?: boolean
}

export interface ReleaseReport {
  ok: boolean
  gates: ReleaseGate[]
  checklist: string[]
}

export interface ReleaseCheckOptions {
  /** Run the heavy shell-out gates (typecheck, lint, build, tests). Default true. */
  full?: boolean
}

// Operator-facing release checklist — static, safe text only.
export const RELEASE_CHECKLIST: string[] = [
  'Required env: NODE_ENV=production, MEDIA_TOKEN_SECRET set, BASE_URL set to the public HTTPS URL.',
  'Recommended explicit secrets: TRUSTED_HOME_PLAYBACK_REFRESH_SECRET and TRUSTED_HOME_VIEWER_IDENTITY_SECRET (avoid derived/dev fallbacks).',
  'If rotating the viewer identity secret: set TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET; remove it after the rotation window.',
  'Take a pre-upgrade database backup (primarily for the nodes table / federation credentials). See docs/TRUSTED_HOME.md → Backup and restore.',
  'Review retention: TRUSTED_HOME_AUDIT_RETENTION_DAYS, TRUSTED_HOME_PROGRESS_OUTBOX_RETENTION_DAYS, TRUSTED_HOME_REMOTE_PROGRESS_RETENTION_DAYS.',
  'Run the smoke harness: pnpm --filter @helix/backend smoke:trusted-home.',
  'Review admin diagnostics: every secretsHealth entry explicit_secret (or knowingly derived); progressOutbox/progressRetention/auditSummary healthy.',
  'Confirm rollback plan: migrations 0017–0019 are additive; code rollback tolerates the extra tables/columns. Destructive rollback needs a backup.',
  'Known limitations: no automatic progress merge mutation, no real-time sync, no cross-node fanout, no mobile/offline progress (see docs).',
]

function findRepoRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) || existsSync(join(dir, 'pnpm-lock.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

// Static no-leak scan of release-facing docs. Examples in docs must not contain
// literal secrets, bearer tokens, credentialed URLs, hash-like hex runs, or
// absolute user filesystem paths.
function scanDocsForLeaks(repoRoot: string): ReleaseGate {
  const docsDir = join(repoRoot, 'docs')
  if (!existsSync(docsDir)) {
    return { name: 'docs_no_leak_scan', ok: true, detail: 'no docs/ directory', skipped: true }
  }
  const forbidden: Array<{ label: string; re: RegExp }> = [
    { label: 'hash/token-like hex run', re: /[a-f0-9]{32,}/i },
    { label: 'bearer token value', re: /Bearer\s+[A-Za-z0-9._-]{16,}/ },
    { label: 'credentialed URL', re: /:\/\/[^\s/]*:[^\s/]*@/ },
    { label: 'absolute user path', re: /\/(home|Users)\/[A-Za-z0-9_.-]+\// },
  ]
  const hits: string[] = []
  const files = readdirSync(docsDir).filter((f) => f.endsWith('.md'))
  for (const f of files) {
    const text = readFileSync(join(docsDir, f), 'utf8')
    for (const { label, re } of forbidden) {
      if (re.test(text)) hits.push(`${f}: ${label}`)
    }
  }
  return {
    name: 'docs_no_leak_scan',
    ok: hits.length === 0,
    detail: hits.length === 0 ? `scanned ${files.length} docs, clean` : `findings: ${hits.join('; ')}`,
  }
}

function runCommandGate(name: string, repoRoot: string, args: string[]): ReleaseGate {
  const res = spawnSync('pnpm', args, { cwd: repoRoot, encoding: 'utf8', timeout: 600000 })
  const ok = res.status === 0
  // Detail is a safe summary only — never the raw child output (could echo paths).
  const detail = ok ? 'passed' : `exit=${res.status ?? 'signal'}`
  return { name, ok, detail }
}

export async function runReleaseCheck(opts: ReleaseCheckOptions = {}): Promise<ReleaseReport> {
  const full = opts.full ?? true
  const repoRoot = findRepoRoot(__dirname)
  const gates: ReleaseGate[] = []

  // ── In-process gates (always) ──────────────────────────────────────────────
  try {
    const smoke = await runTrustedHomeSmoke()
    const failed = smoke.checks.filter((c) => !c.ok).map((c) => c.name)
    gates.push({
      name: 'smoke_harness',
      ok: smoke.ok,
      detail: smoke.ok ? `${smoke.checks.length} checks passed, ${smoke.leak.scanned} responses leak-scanned` : `failed: ${failed.join(', ')}`,
    })
  } catch (e) {
    gates.push({ name: 'smoke_harness', ok: false, detail: `threw: ${(e as Error).message?.slice(0, 80)}` })
  }

  gates.push(scanDocsForLeaks(repoRoot))

  // ── Heavy shell-out gates (full mode only) ─────────────────────────────────
  if (full) {
    gates.push(runCommandGate('typecheck', repoRoot, ['-w', 'typecheck']))
    gates.push(runCommandGate('lint', repoRoot, ['-w', 'lint']))
    gates.push(runCommandGate('build', repoRoot, ['-w', 'build']))
    gates.push(runCommandGate('backend_tests', repoRoot, ['--filter', '@helix/backend', 'test']))
    gates.push(runCommandGate('frontend_tests', repoRoot, ['--filter', '@helix/frontend', 'test']))
  } else {
    for (const name of ['typecheck', 'lint', 'build', 'backend_tests', 'frontend_tests']) {
      gates.push({ name, ok: true, detail: 'skipped (quick mode)', skipped: true })
    }
  }

  const ok = gates.every((g) => g.ok)
  return { ok, gates, checklist: RELEASE_CHECKLIST }
}
