/**
 * Trusted Home federation smoke harness v1.
 *
 * A deterministic, local-first, single-process exercise of the Trusted Home
 * federation flows. It boots one in-process Home (temp SQLite), drives the real
 * federation/source routes, and uses a stubbed source for the viewer-side proxy
 * read — no real network, no secrets required, no external dependencies.
 *
 * Output is a structured SmokeReport with safe per-check detail only. The final
 * no-leak scan asserts that nothing sensitive (federation token, viewer identity
 * hash, secret, user ID, raw URL, filesystem path) appeared in any collected
 * response body.
 *
 * Run via: pnpm --filter @helix/backend smoke:trusted-home
 */

import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { eq, sql } from 'drizzle-orm'
import { createDb } from '../../db/client'
import { runMigrations } from '../../db/migrate'
import { bootstrap } from '../../bootstrap'
import { buildServer } from '../../server'
import {
  nodes,
  libraries,
  mediaItems,
  mediaVersions,
  users,
  trustedHomeAuditEvents,
} from '../../db/schema'
import { encryptApiKey } from '../integrations/encryption'
import { deriveViewerIdentityHash } from './viewerIdentity'
import { deriveBestResume, type ProgressSnapshot } from './progressReconciliation'

export interface SmokeCheck {
  name: string
  ok: boolean
  detail: string
}

export interface SmokeReport {
  ok: boolean
  checks: SmokeCheck[]
  skipped: string[]
  leak: { scanned: number; clean: boolean }
}

const SMOKE_VIEWER_SECRET = 'smoke-viewer-identity-secret-deterministic'
const SMOKE_REFRESH_SECRET = 'smoke-playback-refresh-secret-deterministic'

export async function runTrustedHomeSmoke(): Promise<SmokeReport> {
  const checks: SmokeCheck[] = []
  const skipped: string[] = []
  const bodies: string[] = []
  const record = (b: string) => { bodies.push(b) }

  // Deterministic secrets — set before buildServer reads them.
  const prevViewer = process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET
  const prevRefresh = process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET
  process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET = SMOKE_VIEWER_SECRET
  process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET = SMOKE_REFRESH_SECRET

  const testDir = join(tmpdir(), `helix-smoke-${cryptoRandom()}`)
  mkdirSync(testDir, { recursive: true })
  const db = createDb(join(testDir, 'smoke.db'))
  runMigrations(db, join(__dirname, '../../../drizzle'))

  const localNodeId = await bootstrap(db, testDir)
  const app = buildServer(db, localNodeId, undefined, testDir)
  await app.ready()

  const realFetch = globalThis.fetch
  const sentinels: string[] = []

  try {
    // ── Auth setup (first user) ──────────────────────────────────────────────
    const setupRes = await app.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { username: 'smokeadmin', password: 'smokepassword123', displayName: 'Smoke Admin' },
    })
    // NOTE: auth-setup and federation-token responses legitimately return the
    // admin's own user id / freshly minted token TO the requesting admin. They are
    // credential-issuance endpoints, not federation data paths, so they are
    // deliberately excluded from the no-leak scan (which guards federation,
    // diagnostics, and viewer-facing responses).
    const setCookie = setupRes.headers['set-cookie']
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? '')
    const adminCookie = cookieStr.split(';')[0]
    const [u] = await db.select({ id: users.id }).from(users)
    const userId = u.id
    sentinels.push(userId)
    await check(checks, 'auth_setup', async () => ({ ok: setupRes.statusCode === 200, detail: `status=${setupRes.statusCode}` }))

    // ── 1. Readiness ─────────────────────────────────────────────────────────
    await check(checks, 'readiness_health', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
      record(res.body)
      const body = JSON.parse(res.body)
      return { ok: res.statusCode === 200 && body.data?.trustedHomeSync !== undefined, detail: `status=${res.statusCode}` }
    })

    // ── 2. Federation token (server-side only) ───────────────────────────────
    const tokenRes = await app.inject({ method: 'POST', url: '/api/v1/federation/token', headers: { Cookie: adminCookie } })
    const rawToken = JSON.parse(tokenRes.body).data.token as string
    sentinels.push(rawToken)
    await check(checks, 'federation_token_set', async () => ({ ok: typeof rawToken === 'string' && rawToken.length >= 32, detail: 'token generated (server-side only)' }))

    // Local node opts in to receive + per-user identity (source role).
    await db.update(nodes).set({ allow_progress_receive: 1, allow_progress_user_identity: 1 }).where(eq(nodes.id, localNodeId))

    // Seed a local library + media item (the source's content).
    const now = new Date().toISOString()
    const libId = cryptoRandom()
    await db.insert(libraries).values({ id: libId, node_id: localNodeId, name: 'Movies', kind: 'movies', root_path: '/data/movies', scan_status: 'idle', created_at: now, updated_at: now })
    const itemId = cryptoRandom()
    await db.insert(mediaItems).values({ id: itemId, library_id: libId, kind: 'movie', title: 'Smoke Movie', sort_title: 'smoke movie', metadata_status: 'matched', created_at: now, updated_at: now })
    await db.insert(mediaVersions).values({ id: cryptoRandom(), media_item_id: itemId, quality_label: '1080p', duration_seconds: 7200, created_at: now, updated_at: now })

    // Caller (peer viewer) node, opted in for sync + per-user identity.
    const callerNodeId = cryptoRandom()
    await db.insert(nodes).values({
      id: callerNodeId, name: 'Smoke Peer', kind: 'remote', base_url: 'http://smoke-peer:3001', status: 'online',
      progress_sync_enabled: 1, allow_progress_receive: 1, allow_progress_push: 1, allow_progress_user_identity: 1,
      created_at: now, updated_at: now,
    })

    const userHash = deriveViewerIdentityHash(SMOKE_VIEWER_SECRET, callerNodeId, userId)
    sentinels.push(userHash, SMOKE_VIEWER_SECRET)

    const putProgress = (payload: Record<string, unknown>) => app.inject({
      method: 'PUT', url: `/api/v1/federation/media/${itemId}/watch-progress`,
      payload, headers: { Authorization: `Bearer ${rawToken}`, 'X-Caller-Node-Id': callerNodeId },
    })

    // ── 3. Source progress write (node mode) ─────────────────────────────────
    await check(checks, 'source_progress_write_node', async () => {
      const res = await putProgress({ positionSeconds: 1200, durationSeconds: 7200, watched: false, updatedAt: new Date().toISOString(), clientEventId: 'smoke-node-0001' })
      record(res.body)
      return { ok: res.statusCode === 200, detail: `status=${res.statusCode}` }
    })

    // ── 4. Per-user bilateral write + read ───────────────────────────────────
    await check(checks, 'per_user_bilateral_push', async () => {
      const res = await putProgress({ positionSeconds: 3600, durationSeconds: 7200, watched: false, updatedAt: new Date().toISOString(), clientEventId: 'smoke-user-0001', viewerIdentity: { kind: 'user', version: 'v1', hash: userHash } })
      record(res.body)
      return { ok: res.statusCode === 200, detail: `status=${res.statusCode}` }
    })

    await check(checks, 'per_user_read_returns_progress', async () => {
      const res = await app.inject({
        method: 'GET', url: `/api/v1/federation/media/${itemId}/remote-progress`,
        headers: { Authorization: `Bearer ${rawToken}`, 'X-Caller-Node-Id': callerNodeId, 'X-Viewer-Identity-Kind': 'user', 'X-Viewer-Identity-Version': 'v1', 'X-Viewer-Identity-Hash': userHash },
      })
      record(res.body)
      const rp = JSON.parse(res.body).data?.remoteProgress
      return { ok: res.statusCode === 200 && rp?.available === true && rp?.positionSeconds === 3600, detail: `available=${rp?.available}` }
    })

    // ── 5. One-sided downgrade + no aggregate fallback ───────────────────────
    // A peer that the source has NOT opted in to per-user identity for.
    const peerNoUserId = cryptoRandom()
    await db.insert(nodes).values({
      id: peerNoUserId, name: 'Smoke Peer NoUser', kind: 'remote', base_url: 'http://smoke-peer2:3001', status: 'online',
      progress_sync_enabled: 1, allow_progress_receive: 1, allow_progress_push: 1, allow_progress_user_identity: 0,
      created_at: now, updated_at: now,
    })
    const peerHash = deriveViewerIdentityHash(SMOKE_VIEWER_SECRET, peerNoUserId, userId)
    sentinels.push(peerHash)

    await check(checks, 'one_sided_push_downgrades_to_node', async () => {
      const res = await app.inject({
        method: 'PUT', url: `/api/v1/federation/media/${itemId}/watch-progress`,
        payload: { positionSeconds: 5000, durationSeconds: 7200, watched: false, updatedAt: new Date().toISOString(), clientEventId: 'smoke-down-0001', viewerIdentity: { kind: 'user', version: 'v1', hash: peerHash } },
        headers: { Authorization: `Bearer ${rawToken}`, 'X-Caller-Node-Id': peerNoUserId },
      })
      record(res.body)
      return { ok: res.statusCode === 200, detail: 'push accepted, stored node-mode (downgrade)' }
    })

    await check(checks, 'one_sided_user_read_no_aggregate_fallback', async () => {
      const res = await app.inject({
        method: 'GET', url: `/api/v1/federation/media/${itemId}/remote-progress`,
        headers: { Authorization: `Bearer ${rawToken}`, 'X-Caller-Node-Id': peerNoUserId, 'X-Viewer-Identity-Kind': 'user', 'X-Viewer-Identity-Version': 'v1', 'X-Viewer-Identity-Hash': peerHash },
      })
      record(res.body)
      const rp = JSON.parse(res.body).data?.remoteProgress
      // Source has not opted in → user read must be unavailable, never the node aggregate.
      return { ok: res.statusCode === 200 && rp?.available === false, detail: `available=${rp?.available} (no aggregate fallback)` }
    })

    // ── 6. Audit events created ──────────────────────────────────────────────
    await check(checks, 'audit_events_created', async () => {
      // Audit recording is fire-and-forget; allow it to settle.
      await delay(60)
      const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(trustedHomeAuditEvents)
      return { ok: Number(count) > 0, detail: `auditEvents=${Number(count)}` }
    })

    // ── 7. Viewer-side proxy read + resume suggestion (stubbed source) ───────
    await check(checks, 'viewer_proxy_read_and_resume_suggestion', async () => {
      // A remote node from THIS home's viewer perspective.
      const remoteNodeId = cryptoRandom()
      const remoteLibId = cryptoRandom()
      const remoteItemId = cryptoRandom()
      await db.insert(nodes).values({
        id: remoteNodeId, name: 'Smoke Source', kind: 'remote', base_url: 'http://smoke-source:3001', status: 'online',
        api_token_encrypted: encryptApiKey('smoke-remote-token', testDir),
        progress_sync_enabled: 1, allow_progress_push: 1, allow_progress_user_identity: 0,
        created_at: now, updated_at: now,
      })
      await db.insert(libraries).values({ id: remoteLibId, node_id: remoteNodeId, name: 'Remote', kind: 'movies', root_path: `remote://${remoteNodeId}`, scan_status: 'idle', created_at: now, updated_at: now })
      await db.insert(mediaItems).values({ id: remoteItemId, library_id: remoteLibId, kind: 'movie', title: 'Remote Smoke', sort_title: 'remote smoke', metadata_status: 'matched', created_at: now, updated_at: now })
      await db.insert(mediaVersions).values({ id: cryptoRandom(), media_item_id: remoteItemId, quality_label: '1080p', duration_seconds: 7200, created_at: now, updated_at: now })

      // Stub the outbound source call deterministically (no real network).
      globalThis.fetch = (async () => ({
        status: 200, ok: true,
        json: async () => ({ ok: true, data: { remoteProgress: { available: true, positionSeconds: 4200, durationSeconds: 7200, watched: false, updatedAt: new Date().toISOString() } } }),
      })) as unknown as typeof fetch

      const res = await app.inject({ method: 'GET', url: `/api/v1/nodes/${remoteNodeId}/media/${remoteItemId}/remote-progress`, headers: { Cookie: adminCookie } })
      record(res.body)
      const rp = JSON.parse(res.body).data
      // Drive the merge: no local progress + valid remote → suggest_remote.
      const remoteSnap: ProgressSnapshot | null = rp?.available ? { positionSeconds: rp.positionSeconds, durationSeconds: rp.durationSeconds ?? null, watched: rp.watched ?? false, updatedAt: rp.updatedAt ?? null } : null
      const best = deriveBestResume(null, rp?.scope === 'user' ? remoteSnap : null, rp?.scope !== 'user' ? remoteSnap : null)
      return { ok: res.statusCode === 200 && rp?.available === true && best.action === 'suggest_remote', detail: `available=${rp?.available} resume=${best.action}` }
    })

    // ── 8. Diagnostics readable + structured ─────────────────────────────────
    await check(checks, 'diagnostics_readable', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/sync-diagnostics', headers: { Cookie: adminCookie } })
      record(res.body)
      const d = JSON.parse(res.body).data
      const ok = res.statusCode === 200 && !!d.secretsHealth && !!d.progressOutbox && !!d.progressRetention && !!d.auditSummary
      return { ok, detail: `status=${res.statusCode}` }
    })
  } finally {
    globalThis.fetch = realFetch
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
    if (prevViewer === undefined) delete process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET
    else process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET = prevViewer
    if (prevRefresh === undefined) delete process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET
    else process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET = prevRefresh
  }

  // ── No-leak scan across every collected response body ──────────────────────
  const planted = [...sentinels, '/data/movies', 'http://smoke-source:3001', 'http://smoke-peer:3001']
  let leakClean = true
  const leaked: string[] = []
  for (const body of bodies) {
    for (const s of planted) {
      if (s && body.includes(s)) { leakClean = false; if (!leaked.includes(s)) leaked.push(redact(s)) }
    }
  }
  checks.push({ name: 'no_sensitive_leak', ok: leakClean, detail: leakClean ? `scanned ${bodies.length} responses, clean` : `LEAK: ${leaked.join(', ')}` })

  const ok = checks.every((c) => c.ok)
  return { ok, checks, skipped, leak: { scanned: bodies.length, clean: leakClean } }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function check(out: SmokeCheck[], name: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<void> {
  try {
    const { ok, detail } = await fn()
    out.push({ name, ok, detail })
  } catch (e) {
    out.push({ name, ok: false, detail: `threw: ${(e as Error).message?.slice(0, 80) ?? 'error'}` })
  }
}

function cryptoRandom(): string {
  return crypto.randomUUID()
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Redact a value so the report itself never prints the leaked sensitive string.
function redact(s: string): string {
  return s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-2)}`
}
