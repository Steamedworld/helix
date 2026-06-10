/**
 * Trusted Home Audit Events v1 — tests
 *
 * Covers:
 *   Schema / migration (1 test)
 *   recordAuditEvent — best-effort, non-blocking (2 tests)
 *   GET /admin/audit-events — endpoint shape, pagination, filtering (6 tests)
 *   GET /admin/sync-diagnostics — auditSummary aggregate (2 tests)
 *   PATCH /nodes/:id/settings — settings-changed audit event (2 tests)
 *   PUT /federation/media/:id/watch-progress — progress-received / denied / stale (4 tests)
 *   GET /federation/media/:id/remote-progress — read-denied audit (2 tests)
 *   Security: no sensitive fields in any audit response (3 tests)
 *
 * Total: 22 tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { eq, and } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { setupAuth } from './helpers/auth'
import {
  nodes,
  libraries,
  mediaItems,
  trustedHomeAuditEvents,
} from '../src/db/schema'
import { encryptApiKey } from '../src/services/integrations/encryption'
import { recordAuditEvent } from '../src/services/federation/auditEvents'

// ─── Test env ─────────────────────────────────────────────────────────────────

process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET = 'test-audit-refresh-secret'
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

async function insertRemoteNode(db: TestDb, testDir: string, opts?: {
  progressSyncEnabled?: boolean
  allowProgressPush?: boolean
  allowProgressReceive?: boolean
}) {
  const now = new Date().toISOString()
  const nodeId = crypto.randomUUID()
  await db.insert(nodes).values({
    id: nodeId,
    name: 'Test Remote Home',
    kind: 'remote',
    base_url: 'http://remote-home:3001',
    status: 'online',
    api_token_encrypted: encryptApiKey('test-federation-token', testDir),
    progress_sync_enabled: (opts?.progressSyncEnabled ?? false) ? 1 : 0,
    allow_progress_push: (opts?.allowProgressPush ?? false) ? 1 : 0,
    allow_progress_receive: (opts?.allowProgressReceive ?? false) ? 1 : 0,
    created_at: now,
    updated_at: now,
  })
  return nodeId
}

async function insertLocalLibraryWithItem(db: TestDb, localNodeId: string) {
  const now = new Date().toISOString()
  const libId = crypto.randomUUID()
  await db.insert(libraries).values({
    id: libId,
    node_id: localNodeId,
    name: 'Local Movies',
    kind: 'movies',
    root_path: '/mnt/movies',
    scan_status: 'idle',
    created_at: now,
    updated_at: now,
  })
  const itemId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: itemId,
    library_id: libId,
    kind: 'movie',
    title: 'Test Film',
    sort_title: 'test film',
    metadata_status: 'matched',
    created_at: now,
    updated_at: now,
  })
  return { libId, itemId }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

describe('Schema — trusted_home_audit_events table exists after migration', () => {
  let testDir: string
  let db: TestDb

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-audit-schema-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('can insert and select an audit event row', async () => {
    const now = new Date().toISOString()
    await db.insert(trustedHomeAuditEvents).values({
      id: crypto.randomUUID(),
      occurred_at: now,
      action: 'trusted_home_settings_changed',
      result: 'success',
      reason_code: 'settings_updated',
      node_id: null,
      context_json: null,
      created_at: now,
    })

    const rows = await db.select().from(trustedHomeAuditEvents)
    expect(rows.length).toBe(1)
    expect(rows[0].action).toBe('trusted_home_settings_changed')
    expect(rows[0].result).toBe('success')
    expect(rows[0].reason_code).toBe('settings_updated')
  })
})

// ─── recordAuditEvent ─────────────────────────────────────────────────────────

describe('recordAuditEvent — best-effort, non-blocking', () => {
  let testDir: string
  let db: TestDb

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-audit-record-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('persists a valid audit event asynchronously', async () => {
    recordAuditEvent(db, {
      action: 'progress_push_enqueued',
      result: 'success',
      reasonCode: 'push_accepted',
      nodeId: 'node-abc',
    })

    // Give the async write a tick to complete
    await new Promise((r) => setTimeout(r, 50))

    const rows = await db.select().from(trustedHomeAuditEvents)
    expect(rows.length).toBe(1)
    expect(rows[0].action).toBe('progress_push_enqueued')
    expect(rows[0].result).toBe('success')
    expect(rows[0].node_id).toBe('node-abc')
    expect(rows[0].reason_code).toBe('push_accepted')
  })

  it('does not throw when called — fire-and-forget, no await required', () => {
    // Must not throw synchronously
    expect(() => {
      recordAuditEvent(db, {
        action: 'trusted_home_settings_changed',
        result: 'success',
        reasonCode: 'settings_updated',
      })
    }).not.toThrow()
  })
})

// ─── GET /admin/audit-events ──────────────────────────────────────────────────

describe('GET /admin/audit-events — endpoint shape, pagination, filtering', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-audit-api-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
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

  it('returns empty list when no audit events exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-events',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.events).toEqual([])
    expect(body.data.total).toBe(0)
  })

  it('requires admin — non-admin gets 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-events',
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns inserted events in reverse-chronological order', async () => {
    const now = new Date().toISOString()
    const earlier = new Date(Date.now() - 5000).toISOString()

    await db.insert(trustedHomeAuditEvents).values([
      { id: crypto.randomUUID(), occurred_at: earlier, action: 'progress_push_enqueued', result: 'success', reason_code: 'push_accepted', node_id: null, context_json: null, created_at: earlier },
      { id: crypto.randomUUID(), occurred_at: now, action: 'progress_push_synced', result: 'success', reason_code: 'push_synced', node_id: null, context_json: null, created_at: now },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-events',
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.data.total).toBe(2)
    // Most recent first
    expect(body.data.events[0].action).toBe('progress_push_synced')
    expect(body.data.events[1].action).toBe('progress_push_enqueued')
  })

  it('filters by action when ?action= is provided', async () => {
    const now = new Date().toISOString()
    await db.insert(trustedHomeAuditEvents).values([
      { id: crypto.randomUUID(), occurred_at: now, action: 'progress_push_enqueued', result: 'success', reason_code: null, node_id: null, context_json: null, created_at: now },
      { id: crypto.randomUUID(), occurred_at: now, action: 'trusted_home_settings_changed', result: 'success', reason_code: null, node_id: null, context_json: null, created_at: now },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-events?action=trusted_home_settings_changed',
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.data.total).toBe(1)
    expect(body.data.events[0].action).toBe('trusted_home_settings_changed')
  })

  it('returns 400 for an invalid action filter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-events?action=malicious_action',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(400)
  })

  it('paginates with limit and offset', async () => {
    const now = new Date().toISOString()
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: crypto.randomUUID(),
      occurred_at: new Date(Date.now() - i * 1000).toISOString(),
      action: 'progress_push_enqueued' as const,
      result: 'success' as const,
      reason_code: null,
      node_id: null,
      context_json: null,
      created_at: now,
    }))
    await db.insert(trustedHomeAuditEvents).values(rows)

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-events?limit=2&offset=2',
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.data.total).toBe(5)
    expect(body.data.events.length).toBe(2)
    expect(body.data.limit).toBe(2)
    expect(body.data.offset).toBe(2)
  })
})

// ─── GET /admin/sync-diagnostics — auditSummary ───────────────────────────────

describe('GET /admin/sync-diagnostics — auditSummary aggregate', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-audit-diag-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
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

  it('includes auditSummary.last24h in sync-diagnostics response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.auditSummary).toBeDefined()
    expect(body.data.auditSummary.last24h).toBeDefined()
    const s = body.data.auditSummary.last24h
    expect(typeof s.settingsChanges).toBe('number')
    expect(typeof s.progressPushEnqueued).toBe('number')
    expect(typeof s.progressPushSynced).toBe('number')
    expect(typeof s.progressPushFailed).toBe('number')
    expect(typeof s.progressPushAbandoned).toBe('number')
    expect(typeof s.playbackProxyAttempts).toBe('number')
  })

  it('auditSummary.last24h counts reflect inserted events within window', async () => {
    const now = new Date().toISOString()
    await db.insert(trustedHomeAuditEvents).values([
      { id: crypto.randomUUID(), occurred_at: now, action: 'trusted_home_settings_changed', result: 'success', reason_code: null, node_id: null, context_json: null, created_at: now },
      { id: crypto.randomUUID(), occurred_at: now, action: 'progress_push_synced', result: 'success', reason_code: null, node_id: null, context_json: null, created_at: now },
      { id: crypto.randomUUID(), occurred_at: now, action: 'progress_push_synced', result: 'success', reason_code: null, node_id: null, context_json: null, created_at: now },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.data.auditSummary.last24h.settingsChanges).toBe(1)
    expect(body.data.auditSummary.last24h.progressPushSynced).toBe(2)
  })
})

// ─── PATCH /nodes/:id/settings — settings-changed audit ──────────────────────

describe('PATCH /nodes/:id/settings — emits trusted_home_settings_changed audit event', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-audit-settings-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
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

  it('emits a settings_changed audit event on successful PATCH', async () => {
    const nodeId = await insertRemoteNode(db, testDir)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/nodes/${nodeId}/settings`,
      headers: { Cookie: adminCookie },
      payload: { progressSyncEnabled: true, allowProgressPush: true },
    })
    expect(res.statusCode).toBe(200)

    // Give async write a tick
    await new Promise((r) => setTimeout(r, 50))

    const rows = await db
      .select()
      .from(trustedHomeAuditEvents)
      .where(and(
        eq(trustedHomeAuditEvents.action, 'trusted_home_settings_changed'),
        eq(trustedHomeAuditEvents.node_id, nodeId)
      ))
    expect(rows.length).toBe(1)
    expect(rows[0].result).toBe('success')
    expect(rows[0].reason_code).toBe('settings_updated')
  })

  it('audit event context includes safe boolean fields — no credentials', async () => {
    const nodeId = await insertRemoteNode(db, testDir)

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/nodes/${nodeId}/settings`,
      headers: { Cookie: adminCookie },
      payload: { allowProgressReceive: true },
    })
    await new Promise((r) => setTimeout(r, 50))

    const [row] = await db
      .select()
      .from(trustedHomeAuditEvents)
      .where(eq(trustedHomeAuditEvents.action, 'trusted_home_settings_changed'))

    expect(row).toBeDefined()
    const ctx = row.context_json ? JSON.parse(row.context_json) : null
    expect(ctx).not.toBeNull()
    // Safe booleans only — no tokens, no credentials
    expect(typeof ctx.allowProgressReceive).toBe('boolean')
    const rawCtx = row.context_json ?? ''
    expect(rawCtx).not.toContain('token')
    expect(rawCtx).not.toContain('password')
    expect(rawCtx).not.toContain('encrypted')
    expect(rawCtx).not.toContain('hash')
  })
})

// ─── PUT /federation/.../watch-progress — progress push audit ────────────────

describe('PUT /federation/media/:id/watch-progress — progress received/denied/stale audit', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-audit-push-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
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

  async function getFederationToken(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    return JSON.parse(res.body).data.token as string
  }

  it('emits remote_progress_received/success when push is accepted', async () => {
    // Enable local allow_progress_receive
    await db.update(nodes).set({ allow_progress_receive: 1 }).where(eq(nodes.id, localNodeId))
    const { itemId } = await insertLocalLibraryWithItem(db, localNodeId)

    const remoteNodeId = await insertRemoteNode(db, testDir, { allowProgressPush: true })
    const token = await getFederationToken()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Caller-Node-Id': remoteNodeId,
      },
      payload: {
        positionSeconds: 300,
        durationSeconds: 3600,
        watched: false,
        updatedAt: new Date().toISOString(),
        clientEventId: 'evt-001',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.accepted).toBe(true)

    await new Promise((r) => setTimeout(r, 50))

    const rows = await db
      .select()
      .from(trustedHomeAuditEvents)
      .where(eq(trustedHomeAuditEvents.action, 'remote_progress_received'))
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const success = rows.find((r) => r.result === 'success')
    expect(success).toBeDefined()
    expect(success!.reason_code).toBe('progress_received')
  })

  it('emits remote_progress_received/denied when local allow_progress_receive=0', async () => {
    // Local receive disabled (default)
    const { itemId } = await insertLocalLibraryWithItem(db, localNodeId)
    const token = await getFederationToken()

    await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        positionSeconds: 100,
        durationSeconds: 3600,
        watched: false,
        updatedAt: new Date().toISOString(),
      },
    })

    await new Promise((r) => setTimeout(r, 50))

    const rows = await db
      .select()
      .from(trustedHomeAuditEvents)
      .where(eq(trustedHomeAuditEvents.action, 'remote_progress_received'))
    const denied = rows.find((r) => r.result === 'denied')
    expect(denied).toBeDefined()
    expect(denied!.reason_code).toBe('read_denied_no_sync')
  })

  it('emits remote_progress_received/skipped for stale update', async () => {
    await db.update(nodes).set({ allow_progress_receive: 1 }).where(eq(nodes.id, localNodeId))
    const { itemId } = await insertLocalLibraryWithItem(db, localNodeId)
    const remoteNodeId = await insertRemoteNode(db, testDir, { allowProgressPush: true })
    const token = await getFederationToken()

    const oldTs = new Date(Date.now() - 60000).toISOString()
    const newTs = new Date().toISOString()

    // First push — newer
    await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      headers: { Authorization: `Bearer ${token}`, 'X-Caller-Node-Id': remoteNodeId },
      payload: { positionSeconds: 500, durationSeconds: 3600, watched: false, updatedAt: newTs, clientEventId: 'evt-A' },
    })

    // Second push — older (stale)
    await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      headers: { Authorization: `Bearer ${token}`, 'X-Caller-Node-Id': remoteNodeId },
      payload: { positionSeconds: 100, durationSeconds: 3600, watched: false, updatedAt: oldTs, clientEventId: 'evt-A' },
    })

    await new Promise((r) => setTimeout(r, 50))

    const rows = await db
      .select()
      .from(trustedHomeAuditEvents)
      .where(eq(trustedHomeAuditEvents.action, 'remote_progress_received'))
    const skipped = rows.find((r) => r.result === 'skipped')
    expect(skipped).toBeDefined()
    expect(skipped!.reason_code).toBe('progress_stale_ignored')
  })

  it('emits remote_progress_read_denied/denied for missing caller node', async () => {
    const token = await getFederationToken()
    await db.update(nodes).set({ allow_progress_receive: 1 }).where(eq(nodes.id, localNodeId))
    const { itemId } = await insertLocalLibraryWithItem(db, localNodeId)

    // GET /remote-progress with no X-Caller-Node-Id
    await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: { Authorization: `Bearer ${token}` },
    })

    await new Promise((r) => setTimeout(r, 50))

    const rows = await db
      .select()
      .from(trustedHomeAuditEvents)
      .where(eq(trustedHomeAuditEvents.action, 'remote_progress_read_denied'))
    const denied = rows.find((r) => r.reason_code === 'read_denied_no_node')
    expect(denied).toBeDefined()
    expect(denied!.result).toBe('denied')
  })
})

// ─── Security: no sensitive fields in audit storage or API responses ──────────

describe('Security — no sensitive data in audit events', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-audit-sec-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
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

  it('GET /admin/audit-events response contains no credential fields', async () => {
    const now = new Date().toISOString()
    await db.insert(trustedHomeAuditEvents).values({
      id: crypto.randomUUID(),
      occurred_at: now,
      action: 'trusted_home_settings_changed',
      result: 'success',
      reason_code: 'settings_updated',
      node_id: 'some-node-id',
      context_json: JSON.stringify({ progressSyncEnabled: true }),
      created_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-events',
      headers: { Cookie: adminCookie },
    })
    const raw = res.body
    expect(raw).not.toContain('api_token')
    expect(raw).not.toContain('federation_token')
    expect(raw).not.toContain('password')
    expect(raw).not.toContain('encrypted')
    expect(raw).not.toContain('remote_viewer_hash')
    expect(raw).not.toContain('Authorization')
    expect(raw).not.toContain('stack')
    expect(raw).not.toContain('username')
  })

  it('audit events do not store user_id, remote_viewer_hash, or raw URLs', async () => {
    const nodeId = await insertRemoteNode(db, testDir)

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/nodes/${nodeId}/settings`,
      headers: { Cookie: adminCookie },
      payload: { progressSyncEnabled: true },
    })
    await new Promise((r) => setTimeout(r, 50))

    const rows = await db.select().from(trustedHomeAuditEvents)
    for (const row of rows) {
      // No user_id stored
      const rowStr = JSON.stringify(row)
      expect(rowStr).not.toContain('user_id')
      expect(rowStr).not.toContain('remote_viewer_hash')
      // context_json must not contain raw URLs or tokens
      if (row.context_json) {
        expect(row.context_json).not.toMatch(/https?:\/\//)
        expect(row.context_json).not.toContain('token')
        expect(row.context_json).not.toContain('password')
      }
    }
  })

  it('GET /admin/sync-diagnostics auditSummary contains no event IDs or node IDs in histogram', async () => {
    const now = new Date().toISOString()
    await db.insert(trustedHomeAuditEvents).values({
      id: crypto.randomUUID(),
      occurred_at: now,
      action: 'progress_push_synced',
      result: 'success',
      reason_code: 'push_synced',
      node_id: 'sensitive-node-uuid',
      context_json: null,
      created_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    const auditSummaryStr = JSON.stringify(body.data.auditSummary)

    // auditSummary is aggregate counts — MUST NOT include node IDs or event IDs
    expect(auditSummaryStr).not.toContain('sensitive-node-uuid')
    // All values in last24h must be numbers, not objects with node IDs
    const s = body.data.auditSummary.last24h
    for (const val of Object.values(s)) {
      expect(typeof val).toBe('number')
    }
  })
})
