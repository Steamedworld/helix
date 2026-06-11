/**
 * Per-User Viewer Identity v1 — integration tests
 *
 * Covers:
 *   Federation PUT — bilateral opt-in (3 tests)
 *   Federation PUT — downgrade + downgrade audit + malformed (4 tests)
 *   Federation GET — per-user read path (4 tests)
 *   Node settings — allowProgressUserIdentity (2 tests)
 *   Diagnostics — homesWithPerUserProgressIdentityAllowed + viewerIdentitySecret (2 tests)
 *   Security — no hash/user_id in any response (2 tests)
 *
 * Total: 17 tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { setupAuth } from './helpers/auth'
import {
  nodes,
  libraries,
  mediaItems,
  mediaVersions,
  remoteWatchProgress,
  trustedHomeAuditEvents,
} from '../src/db/schema'
import { encryptApiKey } from '../src/services/integrations/encryption'
import { deriveViewerIdentityHash } from '../src/services/federation/viewerIdentity'

// ─── Test secrets ─────────────────────────────────────────────────────────────

const TEST_VIEWER_IDENTITY_SECRET = 'test-viewer-identity-secret-per-user-tests'
process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET = 'test-per-user-refresh-secret'
process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET = TEST_VIEWER_IDENTITY_SECRET
process.env.TRUSTED_HOME_PLAYBACK_PROXY_ENABLED = 'true'

// ─── DB helpers ───────────────────────────────────────────────────────────────

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

// ─── Fixture helpers ──────────────────────────────────────────────────────────

async function insertLocalItem(db: TestDb, localNodeId: string) {
  const now = new Date().toISOString()
  const libId = crypto.randomUUID()
  await db.insert(libraries).values({
    id: libId, node_id: localNodeId, name: 'Movies', kind: 'movies',
    root_path: '/data/movies', scan_status: 'idle', created_at: now, updated_at: now,
  })
  const itemId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: itemId, library_id: libId, kind: 'movie', title: 'Test Movie',
    sort_title: 'test movie', metadata_status: 'matched', created_at: now, updated_at: now,
  })
  await db.insert(mediaVersions).values({
    id: crypto.randomUUID(), media_item_id: itemId, quality_label: '1080p',
    duration_seconds: 7200, created_at: now, updated_at: now,
  })
  return { libId, itemId }
}

async function insertCallerNode(db: TestDb, opts: {
  allowProgressPush?: boolean
  allowProgressUserIdentity?: boolean
} = {}) {
  const now = new Date().toISOString()
  const callerNodeId = crypto.randomUUID()
  await db.insert(nodes).values({
    id: callerNodeId,
    name: 'Viewer Home',
    kind: 'remote',
    base_url: 'http://viewer-home:3001',
    status: 'online',
    // Sync + receive must be enabled on the caller's row for the federation
    // GET remote-progress guard (bilateral opt-in check) to pass.
    progress_sync_enabled: 1,
    allow_progress_receive: 1,
    allow_progress_push: (opts.allowProgressPush ?? true) ? 1 : 0,
    allow_progress_user_identity: (opts.allowProgressUserIdentity ?? false) ? 1 : 0,
    created_at: now,
    updated_at: now,
  })
  return callerNodeId
}

function validPutBody(overrides: Record<string, unknown> = {}) {
  return {
    positionSeconds: 3600,
    durationSeconds: 7200,
    watched: false,
    updatedAt: new Date().toISOString(),
    clientEventId: 'abcdef0123456789',
    ...overrides,
  }
}

function validUserHash() {
  return deriveViewerIdentityHash(TEST_VIEWER_IDENTITY_SECRET, 'viewer-node-abc', 'user-one')
}

// ─── Part 1: Federation PUT — bilateral opt-in ─────────────────────────────────

describe('Federation PUT — bilateral opt-in (both sides allow_progress_user_identity=1)', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawFederationToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-puvi-put-bilateral-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
    const tokenRes = await app.inject({ method: 'POST', url: '/api/v1/federation/token', headers: { Cookie: adminCookie } })
    rawFederationToken = JSON.parse(tokenRes.body).data.token
    // Enable local receive + user identity
    await db.update(nodes).set({ allow_progress_receive: 1, allow_progress_user_identity: 1 }).where(eq(nodes.id, localNodeId))
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('stores viewer_identity_kind=user and the provided hash when both sides opt in', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true, allowProgressUserIdentity: true })
    const hash = validUserHash()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      payload: validPutBody({ viewerIdentity: { kind: 'user', version: 'v1', hash } }),
      headers: { Authorization: `Bearer ${rawFederationToken}`, 'X-Caller-Node-Id': callerNodeId },
    })
    expect(res.statusCode).toBe(200)

    const rows = await db.select().from(remoteWatchProgress).where(eq(remoteWatchProgress.media_item_id, itemId))
    expect(rows).toHaveLength(1)
    expect(rows[0].viewer_identity_kind).toBe('user')
    expect(rows[0].remote_viewer_hash).toBe(hash)
  })

  it('does not store local user_id anywhere in the remote_watch_progress row', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true, allowProgressUserIdentity: true })
    const hash = validUserHash()

    await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      payload: validPutBody({ viewerIdentity: { kind: 'user', version: 'v1', hash } }),
      headers: { Authorization: `Bearer ${rawFederationToken}`, 'X-Caller-Node-Id': callerNodeId },
    })

    const rows = await db.select().from(remoteWatchProgress).where(eq(remoteWatchProgress.media_item_id, itemId))
    // No user_id column on remoteWatchProgress — the stored hash must not equal a raw userId
    expect(rows[0].remote_viewer_hash).toBe(hash)
    expect(rows[0].remote_viewer_hash).not.toContain('user-one')
  })

  it('second PUT with newer timestamp for same user updates the row (newer-wins preserved)', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true, allowProgressUserIdentity: true })
    const hash = validUserHash()

    const t1 = new Date(Date.now() - 5000).toISOString()
    const t2 = new Date().toISOString()

    await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      payload: validPutBody({ positionSeconds: 100, updatedAt: t1, viewerIdentity: { kind: 'user', version: 'v1', hash } }),
      headers: { Authorization: `Bearer ${rawFederationToken}`, 'X-Caller-Node-Id': callerNodeId },
    })
    await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      payload: validPutBody({ positionSeconds: 3000, updatedAt: t2, viewerIdentity: { kind: 'user', version: 'v1', hash } }),
      headers: { Authorization: `Bearer ${rawFederationToken}`, 'X-Caller-Node-Id': callerNodeId },
    })

    const rows = await db.select().from(remoteWatchProgress).where(eq(remoteWatchProgress.media_item_id, itemId))
    expect(rows).toHaveLength(1)
    expect(rows[0].position_seconds).toBe(3000)
    expect(rows[0].viewer_identity_kind).toBe('user')
  })
})

// ─── Part 2: Federation PUT — downgrade + malformed ───────────────────────────

describe('Federation PUT — one-sided opt-out → downgrade to node mode', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let rawFederationToken: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-puvi-put-downgrade-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
    const tokenRes = await app.inject({ method: 'POST', url: '/api/v1/federation/token', headers: { Cookie: adminCookie } })
    rawFederationToken = JSON.parse(tokenRes.body).data.token
    // Note: the source's per-peer opt-in is the CALLER's node row flag (set per test),
    // not the local node's own row. This update only mirrors default local state.
    await db.update(nodes).set({ allow_progress_receive: 1, allow_progress_user_identity: 0 }).where(eq(nodes.id, localNodeId))
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('stores viewer_identity_kind=node (downgrade) when source allows_progress_user_identity=0', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    // The source's per-peer opt-in lives on the CALLER's node row in the source's DB.
    // allowProgressUserIdentity: false ⇒ this Home (the source) has NOT opted in for this peer.
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true, allowProgressUserIdentity: false })
    const hash = validUserHash()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      payload: validPutBody({ viewerIdentity: { kind: 'user', version: 'v1', hash } }),
      headers: { Authorization: `Bearer ${rawFederationToken}`, 'X-Caller-Node-Id': callerNodeId },
    })
    expect(res.statusCode).toBe(200)

    const rows = await db.select().from(remoteWatchProgress).where(eq(remoteWatchProgress.media_item_id, itemId))
    expect(rows).toHaveLength(1)
    // Downgraded to node mode — the provided user hash must NOT be stored
    expect(rows[0].viewer_identity_kind).toBe('node')
    expect(rows[0].remote_viewer_hash).not.toBe(hash)
  })

  it('records per_user_identity_downgraded audit event without the hash', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true, allowProgressUserIdentity: false })
    const hash = validUserHash()

    await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      payload: validPutBody({ viewerIdentity: { kind: 'user', version: 'v1', hash } }),
      headers: { Authorization: `Bearer ${rawFederationToken}`, 'X-Caller-Node-Id': callerNodeId },
    })

    // Audit recording is fire-and-forget — give it a beat to land
    await new Promise((r) => setTimeout(r, 50))

    const rows = await db
      .select()
      .from(trustedHomeAuditEvents)
      .where(eq(trustedHomeAuditEvents.reason_code, 'per_user_identity_downgraded'))
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('remote_progress_received')
    expect(rows[0].result).toBe('skipped')
    // The viewer identity hash must never appear anywhere in the audit row
    expect(JSON.stringify(rows[0])).not.toContain(hash)
  })

  it('rejects malformed viewerIdentity.kind → 400', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true })

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      payload: validPutBody({ viewerIdentity: { kind: 'hacker', version: 'v1', hash: validUserHash() } }),
      headers: { Authorization: `Bearer ${rawFederationToken}`, 'X-Caller-Node-Id': callerNodeId },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects malformed viewerIdentity.hash (wrong length) → 400', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      payload: validPutBody({ viewerIdentity: { kind: 'user', version: 'v1', hash: 'tooshort' } }),
      headers: { Authorization: `Bearer ${rawFederationToken}`, 'X-Caller-Node-Id': (await insertCallerNode(db, { allowProgressPush: true })) },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ─── Part 3: Federation GET — per-user read path ──────────────────────────────

describe('Federation GET — per-user viewer identity read path', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let rawFederationToken: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-puvi-get-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
    const tokenRes = await app.inject({ method: 'POST', url: '/api/v1/federation/token', headers: { Cookie: adminCookie } })
    rawFederationToken = JSON.parse(tokenRes.body).data.token
    await db.update(nodes).set({ allow_progress_receive: 1, allow_progress_user_identity: 1 }).where(eq(nodes.id, localNodeId))
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  async function insertProgressRow(db: TestDb, opts: {
    sourceNodeId: string
    mediaItemId: string
    hash: string
    kind: 'node' | 'user'
    positionSeconds: number
  }) {
    const now = new Date().toISOString()
    await db.insert(remoteWatchProgress).values({
      id: crypto.randomUUID(),
      source_node_id: opts.sourceNodeId,
      media_item_id: opts.mediaItemId,
      remote_viewer_hash: opts.hash,
      viewer_identity_kind: opts.kind,
      position_seconds: opts.positionSeconds,
      duration_seconds: 7200,
      watched: 0,
      updated_at: now,
      client_event_id: 'test-event-' + crypto.randomUUID().slice(0, 8),
      created_at: now,
    })
  }

  it('returns user_v1 row when headers are valid and source has opted in', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true, allowProgressUserIdentity: true })
    const hash = validUserHash()
    await insertProgressRow(db, { sourceNodeId: callerNodeId, mediaItemId: itemId, hash, kind: 'user', positionSeconds: 4200 })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: {
        Authorization: `Bearer ${rawFederationToken}`,
        'X-Caller-Node-Id': callerNodeId,
        'X-Viewer-Identity-Kind': 'user',
        'X-Viewer-Identity-Version': 'v1',
        'X-Viewer-Identity-Hash': hash,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.remoteProgress.available).toBe(true)
    expect(body.data.remoteProgress.positionSeconds).toBe(4200)
  })

  it('returns available:false on per-user miss — does not fall back to node aggregate', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true, allowProgressUserIdentity: true })

    // Insert a node-mode row (should NOT be returned when user-mode is requested)
    const nodeHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0'
    await insertProgressRow(db, { sourceNodeId: callerNodeId, mediaItemId: itemId, hash: nodeHash, kind: 'node', positionSeconds: 9000 })

    const userHash = validUserHash()
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: {
        Authorization: `Bearer ${rawFederationToken}`,
        'X-Caller-Node-Id': callerNodeId,
        'X-Viewer-Identity-Kind': 'user',
        'X-Viewer-Identity-Version': 'v1',
        'X-Viewer-Identity-Hash': userHash,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    // Must not leak the node-mode row (9000s position)
    expect(body.data.remoteProgress.available).toBe(false)
  })

  it('returns available:false when source allow_progress_user_identity=0 (one-sided)', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    // The source's per-peer opt-in lives on the CALLER's node row in the source's DB.
    // allowProgressUserIdentity: false ⇒ this Home (the source) has NOT opted in for this peer.
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true, allowProgressUserIdentity: false })
    const hash = validUserHash()

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: {
        Authorization: `Bearer ${rawFederationToken}`,
        'X-Caller-Node-Id': callerNodeId,
        'X-Viewer-Identity-Kind': 'user',
        'X-Viewer-Identity-Version': 'v1',
        'X-Viewer-Identity-Hash': hash,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.remoteProgress.available).toBe(false)
  })

  it('falls back to node aggregate when no identity headers are provided (node mode unchanged)', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true, allowProgressUserIdentity: true })
    const nodeHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01'
    await insertProgressRow(db, { sourceNodeId: callerNodeId, mediaItemId: itemId, hash: nodeHash, kind: 'node', positionSeconds: 1800 })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: { Authorization: `Bearer ${rawFederationToken}`, 'X-Caller-Node-Id': callerNodeId },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.remoteProgress.available).toBe(true)
    expect(body.data.remoteProgress.positionSeconds).toBe(1800)
  })
})

// ─── Part 4: Node settings — allowProgressUserIdentity ────────────────────────

describe('Node settings — allowProgressUserIdentity', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-puvi-settings-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('defaults to false and can be toggled to true by admin', async () => {
    const now = new Date().toISOString()
    const nodeId = crypto.randomUUID()
    await db.insert(nodes).values({ id: nodeId, name: 'Peer', kind: 'remote', base_url: 'http://peer:3001', status: 'online', created_at: now, updated_at: now })

    // Default is false
    const [row] = await db.select({ allow_progress_user_identity: nodes.allow_progress_user_identity }).from(nodes).where(eq(nodes.id, nodeId))
    expect(row.allow_progress_user_identity).toBe(0)

    // Toggle via PATCH
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/nodes/${nodeId}/settings`,
      payload: { allowProgressUserIdentity: true },
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.allowProgressUserIdentity).toBe(true)

    const [updated] = await db.select({ allow_progress_user_identity: nodes.allow_progress_user_identity }).from(nodes).where(eq(nodes.id, nodeId))
    expect(updated.allow_progress_user_identity).toBe(1)
  })

  it('setting appears in the sanitized node record returned by GET /nodes', async () => {
    const now = new Date().toISOString()
    const nodeId = crypto.randomUUID()
    await db.insert(nodes).values({ id: nodeId, name: 'Peer', kind: 'remote', base_url: 'http://peer:3001', status: 'online', created_at: now, updated_at: now, allow_progress_user_identity: 1 })

    const res = await app.inject({ method: 'GET', url: `/api/v1/nodes/${nodeId}`, headers: { Cookie: adminCookie } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.allowProgressUserIdentity).toBe(true)
  })
})

// ─── Part 5: Diagnostics ──────────────────────────────────────────────────────

describe('Sync diagnostics — homesWithPerUserProgressIdentityAllowed + viewerIdentitySecret', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-puvi-diag-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('homesWithPerUserProgressIdentityAllowed reflects actual count', async () => {
    const now = new Date().toISOString()
    await db.insert(nodes).values({ id: crypto.randomUUID(), name: 'PeerA', kind: 'remote', base_url: 'http://a:3001', status: 'online', allow_progress_user_identity: 1, created_at: now, updated_at: now })
    await db.insert(nodes).values({ id: crypto.randomUUID(), name: 'PeerB', kind: 'remote', base_url: 'http://b:3001', status: 'online', allow_progress_user_identity: 0, created_at: now, updated_at: now })

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/sync-diagnostics', headers: { Cookie: adminCookie } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.playbackDiagnostics.homesWithPerUserProgressIdentityAllowed).toBe(1)
  })

  it('viewerIdentitySecret health is present in secretsHealth (state label only — no secret value)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/sync-diagnostics', headers: { Cookie: adminCookie } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const health = body.data.secretsHealth?.viewerIdentitySecret
    expect(health).toBeDefined()
    expect(['explicit_secret', 'derived_fallback', 'dev_random', 'missing']).toContain(health.state)
    // Must never include secret value, hash, or raw env var contents
    const raw = res.body
    expect(raw).not.toContain(TEST_VIEWER_IDENTITY_SECRET)
  })
})

// ─── Part 6: Security assertions ─────────────────────────────────────────────

describe('Security — viewer hash never appears in API responses', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let rawFederationToken: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-puvi-security-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
    const tokenRes = await app.inject({ method: 'POST', url: '/api/v1/federation/token', headers: { Cookie: adminCookie } })
    rawFederationToken = JSON.parse(tokenRes.body).data.token
    await db.update(nodes).set({ allow_progress_receive: 1, allow_progress_user_identity: 1 }).where(eq(nodes.id, localNodeId))
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('PUT response body does not contain the viewer identity hash', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true, allowProgressUserIdentity: true })
    const hash = validUserHash()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      payload: validPutBody({ viewerIdentity: { kind: 'user', version: 'v1', hash } }),
      headers: { Authorization: `Bearer ${rawFederationToken}`, 'X-Caller-Node-Id': callerNodeId },
    })
    expect(res.statusCode).toBe(200)
    // Response must not echo back the hash
    expect(res.body).not.toContain(hash)
  })

  it('GET response body does not contain the viewer identity hash', async () => {
    const { itemId } = await insertLocalItem(db, localNodeId)
    const callerNodeId = await insertCallerNode(db, { allowProgressPush: true, allowProgressUserIdentity: true })
    const hash = validUserHash()

    const nowIso = new Date().toISOString()
    await db.insert(remoteWatchProgress).values({
      id: crypto.randomUUID(), source_node_id: callerNodeId, media_item_id: itemId,
      remote_viewer_hash: hash, viewer_identity_kind: 'user',
      position_seconds: 1000, duration_seconds: 7200, watched: 0,
      updated_at: nowIso, client_event_id: 'sec-test-0001', created_at: nowIso,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: {
        Authorization: `Bearer ${rawFederationToken}`,
        'X-Caller-Node-Id': callerNodeId,
        'X-Viewer-Identity-Kind': 'user',
        'X-Viewer-Identity-Version': 'v1',
        'X-Viewer-Identity-Hash': hash,
      },
    })
    expect(res.statusCode).toBe(200)
    // Response must not echo back the hash
    expect(res.body).not.toContain(hash)
  })
})
