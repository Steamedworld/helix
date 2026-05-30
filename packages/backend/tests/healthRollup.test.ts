/**
 * Tests for the Trusted Home sync health rollup in GET /api/v1/health.
 *
 * Covers:
 *   - Health rollup counts (7 tests)
 *   - Aggregated timestamps (2 tests)
 *   - Safety / no-leakage (5 tests)
 *   - Compatibility (3 tests)
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
import { nodes } from '../src/db/schema'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

// ─── Shared setup helpers ─────────────────────────────────────────────────────

async function insertRemoteNode(db: TestDb, overrides: Partial<{
  last_sync_at: number | null
  last_sync_attempt_at: string | null
  last_sync_error_at: string | null
  last_sync_error_code: string | null
  last_sync_error_message: string | null
}> = {}): Promise<string> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.insert(nodes).values({
    id,
    name: `Remote-${id.slice(0, 8)}`,
    kind: 'remote',
    base_url: 'http://remote:3001',
    api_token_encrypted: 'enc:tok',
    status: 'unknown',
    created_at: now,
    updated_at: now,
    last_sync_at: null,
    last_sync_attempt_at: null,
    last_sync_error_at: null,
    last_sync_error_code: null,
    last_sync_error_message: null,
    ...overrides,
  })
  return id
}

// ─── Health rollup counts ─────────────────────────────────────────────────────

describe('GET /api/v1/health — trustedHomeSync counts', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-health-rollup-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 1: /health includes trustedHomeSync object
  it('response includes trustedHomeSync object', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.trustedHomeSync).toBeDefined()
    expect(typeof body.data.trustedHomeSync).toBe('object')
  })

  // Test 2: total is correct count of trusted-home nodes
  it('total reflects the count of remote nodes only', async () => {
    // localNodeId is a 'local' node — should not count
    await insertRemoteNode(db)
    await insertRemoteNode(db)

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.trustedHomeSync.total).toBe(2)
  })

  // Test 3: healthy count
  it('healthy count is correct — recent sync, no error', async () => {
    const now = new Date().toISOString()
    // One healthy node: recent sync within retention, no error
    await insertRemoteNode(db, {
      last_sync_at: Date.now() - 3600_000, // 1 hour ago
      last_sync_attempt_at: now,
      last_sync_error_code: null,
    })
    // One never-synced
    await insertRemoteNode(db, {
      last_sync_at: null,
      last_sync_attempt_at: null,
      last_sync_error_code: null,
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const sync = JSON.parse(res.body).data.trustedHomeSync
    expect(sync.healthy).toBe(1)
    expect(sync.total).toBe(2)
  })

  // Test 4: failing count
  it('failing count is correct — active error_code set', async () => {
    const now = new Date().toISOString()
    await insertRemoteNode(db, {
      last_sync_at: Date.now() - 3600_000,
      last_sync_attempt_at: now,
      last_sync_error_code: 'remote_unreachable',
      last_sync_error_message: 'Remote home is unreachable.',
      last_sync_error_at: now,
    })
    await insertRemoteNode(db, {
      last_sync_at: Date.now() - 3600_000,
      last_sync_attempt_at: now,
      last_sync_error_code: 'auth_failed',
      last_sync_error_message: 'Remote home rejected the trusted-home token.',
      last_sync_error_at: now,
    })
    // One healthy
    await insertRemoteNode(db, {
      last_sync_at: Date.now() - 3600_000,
      last_sync_attempt_at: now,
      last_sync_error_code: null,
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const sync = JSON.parse(res.body).data.trustedHomeSync
    expect(sync.failing).toBe(2)
    expect(sync.healthy).toBe(1)
    expect(sync.total).toBe(3)
  })

  // Test 5: stale count — last sync older than tombstone retention
  it('stale count is correct — last sync outside retention window', async () => {
    const now = new Date().toISOString()
    // 100 days ago — beyond default 90-day retention
    const staleSyncAt = Date.now() - 100 * 24 * 60 * 60 * 1000
    await insertRemoteNode(db, {
      last_sync_at: staleSyncAt,
      last_sync_attempt_at: now,
      last_sync_error_code: null,
    })
    // Healthy
    await insertRemoteNode(db, {
      last_sync_at: Date.now() - 3600_000,
      last_sync_attempt_at: now,
      last_sync_error_code: null,
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const sync = JSON.parse(res.body).data.trustedHomeSync
    expect(sync.stale).toBe(1)
    expect(sync.healthy).toBe(1)
  })

  // Test 6: neverSynced count
  it('neverSynced count is correct — no attempt, no success', async () => {
    await insertRemoteNode(db, {
      last_sync_at: null,
      last_sync_attempt_at: null,
      last_sync_error_code: null,
    })
    await insertRemoteNode(db, {
      last_sync_at: null,
      last_sync_attempt_at: null,
      last_sync_error_code: null,
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const sync = JSON.parse(res.body).data.trustedHomeSync
    expect(sync.neverSynced).toBe(2)
  })

  // Test 7: hasFailures
  it('hasFailures is true when failing > 0, false when failing === 0', async () => {
    const now = new Date().toISOString()
    // No nodes yet → no failures
    const res0 = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(JSON.parse(res0.body).data.trustedHomeSync.hasFailures).toBe(false)

    // Add a failing node
    await insertRemoteNode(db, {
      last_sync_at: Date.now() - 3600_000,
      last_sync_attempt_at: now,
      last_sync_error_code: 'timeout',
      last_sync_error_message: 'Remote home did not respond in time.',
      last_sync_error_at: now,
    })

    const res1 = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(JSON.parse(res1.body).data.trustedHomeSync.hasFailures).toBe(true)
    expect(JSON.parse(res1.body).data.trustedHomeSync.failing).toBe(1)
  })
})

// ─── Aggregated timestamps ────────────────────────────────────────────────────

describe('GET /api/v1/health — trustedHomeSync timestamps', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-health-ts-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 8: oldestActiveErrorAt returns oldest error timestamp
  it('oldestActiveErrorAt returns oldest error timestamp among failing nodes', async () => {
    const errorAt1 = '2026-05-10T08:00:00.000Z' // older
    const errorAt2 = '2026-05-20T08:00:00.000Z' // newer
    const now = new Date().toISOString()

    await insertRemoteNode(db, {
      last_sync_at: Date.now() - 3600_000,
      last_sync_attempt_at: now,
      last_sync_error_code: 'auth_failed',
      last_sync_error_message: 'Remote home rejected the trusted-home token.',
      last_sync_error_at: errorAt2,
    })
    await insertRemoteNode(db, {
      last_sync_at: Date.now() - 3600_000,
      last_sync_attempt_at: now,
      last_sync_error_code: 'remote_unreachable',
      last_sync_error_message: 'Remote home is unreachable.',
      last_sync_error_at: errorAt1,
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const sync = JSON.parse(res.body).data.trustedHomeSync
    expect(sync.oldestActiveErrorAt).toBe(errorAt1)
  })

  // Test 9: newestAttemptAt returns newest attempt across all nodes
  it('newestAttemptAt returns newest attempt timestamp across all nodes', async () => {
    const attemptAt1 = '2026-05-28T06:00:00.000Z'
    const attemptAt2 = '2026-05-30T06:00:00.000Z' // newest

    await insertRemoteNode(db, {
      last_sync_at: Date.now() - 3600_000,
      last_sync_attempt_at: attemptAt1,
      last_sync_error_code: null,
    })
    await insertRemoteNode(db, {
      last_sync_at: Date.now() - 3600_000,
      last_sync_attempt_at: attemptAt2,
      last_sync_error_code: null,
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const sync = JSON.parse(res.body).data.trustedHomeSync
    expect(sync.newestAttemptAt).toBe(attemptAt2)
  })
})

// ─── Safety tests ─────────────────────────────────────────────────────────────

describe('GET /api/v1/health — trustedHomeSync safety (no leakage)', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-health-safety-${crypto.randomUUID()}`)
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

  async function addRemoteNodeViaApi() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'SecretRemote', base_url: 'http://secret-host:3001', api_token: 'super-secret-token' },
    })
    return JSON.parse(res.body).data.id as string
  }

  // Test 10: Health response does not contain node IDs
  it('health response does not contain node IDs', async () => {
    const nodeId = await addRemoteNodeViaApi()
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    // Node ID is a UUID — should not appear in the aggregate response
    expect(res.body).not.toContain(nodeId)
  })

  // Test 11: Health response does not contain node names or remote addresses
  it('health response does not contain node names or remote addresses', async () => {
    await addRemoteNodeViaApi()
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('SecretRemote')
    expect(res.body).not.toContain('secret-host')
    expect(res.body).not.toContain('3001')
  })

  // Test 12: Health response does not contain error messages or error codes
  it('health response does not contain error messages or error codes', async () => {
    const nodeId = await addRemoteNodeViaApi()
    const now = new Date().toISOString()
    await db.update(nodes).set({
      last_sync_error_code: 'auth_failed',
      last_sync_error_message: 'Remote home rejected the trusted-home token.',
      last_sync_error_at: now,
    }).where(eq(nodes.id, nodeId))

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    // The health endpoint must NOT expose individual error codes or messages
    const data = JSON.parse(res.body).data
    expect(data.trustedHomeSync).not.toHaveProperty('lastSyncErrorCode')
    expect(data.trustedHomeSync).not.toHaveProperty('lastSyncErrorMessage')
    expect(data.trustedHomeSync).not.toHaveProperty('errorCode')
    expect(data.trustedHomeSync).not.toHaveProperty('errorMessage')
  })

  // Test 13: Health response does not contain tokens, credentials, file paths, or stack traces
  it('health response does not contain tokens, credentials, file paths, or stack traces', async () => {
    await addRemoteNodeViaApi()
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const raw = res.body
    expect(raw).not.toContain('super-secret-token')
    expect(raw).not.toContain('api_token')
    expect(raw).not.toContain('api_token_encrypted')
    expect(raw).not.toContain('federation_token')
    expect(raw).not.toContain('encrypted')
    expect(raw).not.toContain('password')
    expect(raw).not.toContain('/var/')
    expect(raw).not.toContain('stack')
  })

  // Test 14: Empty trusted-home list returns total: 0, hasFailures: false safely
  it('empty trusted-home list returns total: 0, hasFailures: false with no error', async () => {
    // No remote nodes added
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const sync = JSON.parse(res.body).data.trustedHomeSync
    expect(sync.total).toBe(0)
    expect(sync.hasFailures).toBe(false)
    expect(sync.healthy).toBe(0)
    expect(sync.failing).toBe(0)
    expect(sync.oldestActiveErrorAt).toBeNull()
    expect(sync.newestAttemptAt).toBeNull()
  })
})

// ─── Compatibility tests ──────────────────────────────────────────────────────

describe('GET /api/v1/health — backward compatibility', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-health-compat-${crypto.randomUUID()}`)
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

  // Test 15: Existing health fields still present
  it('existing health fields are all still present', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.status).toBe('ok')
    expect(typeof data.version).toBe('string')
    expect(typeof data.node).toBe('string')
    expect(typeof data.autoSync).toBe('object')
    expect(typeof data.autoSync.enabled).toBe('boolean')
    expect(typeof data.autoSync.intervalMs).toBe('number')
    expect(typeof data.tombstoneRetentionDays).toBe('number')
  })

  // Test 16: Admin diagnostics endpoint still returns full per-node details (regression)
  it('admin diagnostics still returns full per-node trustedHomeSync array', async () => {
    // Add a remote node and set some fields
    const addRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'AdminNode', base_url: 'http://adminnode:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(addRes.body).data.id
    const now = new Date().toISOString()
    await db.update(nodes).set({
      last_sync_attempt_at: now,
      last_sync_error_code: 'remote_unreachable',
      last_sync_error_message: 'Remote home is unreachable.',
      last_sync_error_at: now,
    }).where(eq(nodes.id, nodeId))

    const diagRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(diagRes.statusCode).toBe(200)
    const diagData = JSON.parse(diagRes.body).data
    // Admin diagnostics must still return array of per-node entries
    expect(Array.isArray(diagData.trustedHomeSync)).toBe(true)
    const entry = diagData.trustedHomeSync.find((h: Record<string, unknown>) => h.nodeId === nodeId)
    expect(entry).toBeDefined()
    // Admin endpoint exposes per-node detail
    expect(entry.name).toBe('AdminNode')
    expect(entry.nodeId).toBe(nodeId)
    expect(entry.lastSyncErrorCode).toBe('remote_unreachable')
    expect(entry.syncHealth).toBe('failing')
  })

  // Test 17: computeSyncSafetyEstimate and deriveSyncHealth produce consistent classification
  it('health rollup and admin diagnostics classify the same node identically', async () => {
    const addRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'ConsistNode', base_url: 'http://consist:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(addRes.body).data.id

    // Set the node to a known state: recent sync, no error → healthy
    const now = new Date().toISOString()
    await db.update(nodes).set({
      last_sync_at: Date.now() - 3600_000,
      last_sync_attempt_at: now,
      last_sync_error_code: null,
    }).where(eq(nodes.id, nodeId))

    const healthRes = await app.inject({ method: 'GET', url: '/api/v1/health' })
    const adminRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })

    expect(healthRes.statusCode).toBe(200)
    expect(adminRes.statusCode).toBe(200)

    const healthSync = JSON.parse(healthRes.body).data.trustedHomeSync
    const adminEntry = JSON.parse(adminRes.body).data.trustedHomeSync.find(
      (h: Record<string, unknown>) => h.nodeId === nodeId
    )

    // Both must agree: node is healthy
    expect(adminEntry.syncHealth).toBe('healthy')
    // Health endpoint shows healthy: 1
    expect(healthSync.healthy).toBe(1)
    expect(healthSync.failing).toBe(0)
    expect(healthSync.hasFailures).toBe(false)
  })
})
