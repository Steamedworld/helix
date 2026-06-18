/**
 * Viewer Identity Secret Rotation Compatibility v1 — tests
 *
 * Covers:
 *   - previous secret derives a different hash than current
 *   - current hash is tried first; previous only on a user-mode miss
 *   - current hit → no previous attempt
 *   - node mode → no identity headers and no previous retry
 *   - push derivation uses the CURRENT secret only
 *   - no browser response contains a hash, secret, or user ID
 *   - secret diagnostics expose labels/recommendations only
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { setupAuth } from './helpers/auth'
import { nodes, libraries, mediaItems, mediaVersions, users } from '../src/db/schema'
import { encryptApiKey } from '../src/services/integrations/encryption'
import {
  deriveViewerIdentityHash,
} from '../src/services/federation/viewerIdentity'
import { resolveViewerIdentitySecret, resolveViewerIdentityPreviousSecret } from '../src/config'

const CURRENT_SECRET = 'rotation-current-secret-aaaaaaaaaaaa'
const PREVIOUS_SECRET = 'rotation-previous-secret-bbbbbbbbbbbb'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const db = createDb(join(testDir, 'test.db'))
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}
type TestDb = ReturnType<typeof createDb>

async function insertRemoteNodeAndItem(db: TestDb, testDir: string, opts: { userIdentity: boolean }) {
  const now = new Date().toISOString()
  const remoteNodeId = crypto.randomUUID()
  await db.insert(nodes).values({
    id: remoteNodeId,
    name: 'Source Home',
    kind: 'remote',
    base_url: 'http://source-home:3001',
    status: 'online',
    api_token_encrypted: encryptApiKey('remote-federation-token', testDir),
    progress_sync_enabled: 1,
    allow_progress_push: 1,
    allow_progress_user_identity: opts.userIdentity ? 1 : 0,
    created_at: now,
    updated_at: now,
  })
  const remoteLibId = crypto.randomUUID()
  await db.insert(libraries).values({
    id: remoteLibId, node_id: remoteNodeId, name: 'Remote Movies', kind: 'movies',
    root_path: `remote://${remoteNodeId}`, scan_status: 'idle', created_at: now, updated_at: now,
  })
  const remoteItemId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: remoteItemId, library_id: remoteLibId, kind: 'movie', title: 'Remote Movie',
    sort_title: 'remote movie', metadata_status: 'matched', created_at: now, updated_at: now,
  })
  await db.insert(mediaVersions).values({
    id: crypto.randomUUID(), media_item_id: remoteItemId, quality_label: '1080p',
    duration_seconds: 7200, created_at: now, updated_at: now,
  })
  return { remoteNodeId, remoteItemId }
}

type CapturedCall = { url: string; idKind?: string; idHash?: string }

function stubFetchSequence(responses: Array<{ available: boolean; positionSeconds?: number }>, captured: CapturedCall[]) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, opts: { headers?: Record<string, string> }) => {
    const headers = opts?.headers ?? {}
    captured.push({ url, idKind: headers['X-Viewer-Identity-Kind'], idHash: headers['X-Viewer-Identity-Hash'] })
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    const remoteProgress = r.available
      ? { available: true, positionSeconds: r.positionSeconds ?? 4242, durationSeconds: 7200, watched: false, updatedAt: new Date().toISOString() }
      : { available: false }
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, data: { remoteProgress } }) })
  }))
}

describe('Viewer identity secret rotation compatibility', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let userId: string
  const prevEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    prevEnv.cur = process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET
    prevEnv.prev = process.env.TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET
    prevEnv.refresh = process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET
    process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET = CURRENT_SECRET
    process.env.TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET = PREVIOUS_SECRET
    process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET = 'rotation-refresh-secret'

    testDir = join(tmpdir(), `helix-vir-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
    const [u] = await db.select({ id: users.id }).from(users)
    userId = u.id
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
    process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET = prevEnv.cur
    process.env.TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET = prevEnv.prev
    process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET = prevEnv.refresh
  })

  it('previous secret derives a different hash than current', () => {
    const cur = deriveViewerIdentityHash(CURRENT_SECRET, localNodeId, userId)
    const prev = deriveViewerIdentityHash(PREVIOUS_SECRET, localNodeId, userId)
    expect(cur).not.toBe(prev)
    expect(cur).toMatch(/^[a-f0-9]{32}$/)
    expect(prev).toMatch(/^[a-f0-9]{32}$/)
  })

  it('push derivation uses the CURRENT secret only (resolveViewerIdentitySecret)', () => {
    const pushHash = deriveViewerIdentityHash(resolveViewerIdentitySecret(), localNodeId, userId)
    expect(pushHash).toBe(deriveViewerIdentityHash(CURRENT_SECRET, localNodeId, userId))
    expect(resolveViewerIdentityPreviousSecret()).toBe(PREVIOUS_SECRET)
    // Push never uses the previous secret.
    expect(pushHash).not.toBe(deriveViewerIdentityHash(PREVIOUS_SECRET, localNodeId, userId))
  })

  it('tries current hash first, then previous on a user-mode miss; returns previous_secret_match', async () => {
    const { remoteNodeId, remoteItemId } = await insertRemoteNodeAndItem(db, testDir, { userIdentity: true })
    const captured: CapturedCall[] = []
    // First (current) → miss; second (previous) → hit
    stubFetchSequence([{ available: false }, { available: true, positionSeconds: 4242 }], captured)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${remoteItemId}/remote-progress`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body).data

    const curHash = deriveViewerIdentityHash(CURRENT_SECRET, localNodeId, userId)
    const prevHash = deriveViewerIdentityHash(PREVIOUS_SECRET, localNodeId, userId)
    expect(captured).toHaveLength(2)
    expect(captured[0].idHash).toBe(curHash) // current first
    expect(captured[1].idHash).toBe(prevHash) // previous on miss
    expect(body.available).toBe(true)
    expect(body.scope).toBe('user')
    expect(body.identityKeyState).toBe('previous_secret_match')
    expect(body.positionSeconds).toBe(4242)
    // No hash anywhere in the response
    expect(res.body).not.toContain(curHash)
    expect(res.body).not.toContain(prevHash)
  })

  it('does NOT attempt the previous secret when the current secret hits', async () => {
    const { remoteNodeId, remoteItemId } = await insertRemoteNodeAndItem(db, testDir, { userIdentity: true })
    const captured: CapturedCall[] = []
    stubFetchSequence([{ available: true, positionSeconds: 1800 }], captured)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${remoteItemId}/remote-progress`,
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body).data
    expect(captured).toHaveLength(1) // no previous-secret retry
    expect(body.identityKeyState).toBe('current_secret_match')
    expect(body.scope).toBe('user')
  })

  it('node mode (opt-out) sends no identity headers and never retries with previous', async () => {
    const { remoteNodeId, remoteItemId } = await insertRemoteNodeAndItem(db, testDir, { userIdentity: false })
    const captured: CapturedCall[] = []
    stubFetchSequence([{ available: false }], captured)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${remoteItemId}/remote-progress`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].idKind).toBeUndefined() // no per-user identity headers in node mode
    expect(captured[0].idHash).toBeUndefined()
  })

  it('no browser response leaks a hash, secret, or user ID', async () => {
    const { remoteNodeId, remoteItemId } = await insertRemoteNodeAndItem(db, testDir, { userIdentity: true })
    const captured: CapturedCall[] = []
    stubFetchSequence([{ available: false }, { available: true, positionSeconds: 100 }], captured)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${remoteItemId}/remote-progress`,
      headers: { Cookie: adminCookie },
    })
    expect(res.body).not.toContain(CURRENT_SECRET)
    expect(res.body).not.toContain(PREVIOUS_SECRET)
    expect(res.body).not.toContain(userId)
    expect(res.body).not.toContain(deriveViewerIdentityHash(CURRENT_SECRET, localNodeId, userId))
    expect(res.body).not.toContain(deriveViewerIdentityHash(PREVIOUS_SECRET, localNodeId, userId))
  })

  it('diagnostics expose only safe labels: previousSecretConfigured + rotation recommendation, no secret value', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/sync-diagnostics', headers: { Cookie: adminCookie } })
    expect(res.statusCode).toBe(200)
    const health = JSON.parse(res.body).data.secretsHealth?.viewerIdentitySecret
    expect(health).toBeDefined()
    expect(health.state).toBe('explicit_secret')
    expect(health.previousSecretConfigured).toBe(true)
    expect(health.recommendation).toContain('rotation continuity')
    // Never the secret values
    expect(res.body).not.toContain(CURRENT_SECRET)
    expect(res.body).not.toContain(PREVIOUS_SECRET)
  })
})
