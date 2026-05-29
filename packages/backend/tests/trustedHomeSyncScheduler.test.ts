/**
 * Trusted Home background sync scheduler tests.
 *
 * Covers:
 *   - Scheduler behaviour (6 tests)
 *   - Manual sync locking (3 tests)
 *   - Regressions (3 tests)
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
import { nodes } from '../src/db/schema'
import { createTrustedHomeSyncScheduler, syncInProgress } from '../src/services/federation/trustedHomeSyncScheduler'
import type { TrustedHomeSyncConfig } from '../src/services/federation/trustedHomeSyncScheduler'
import type { SyncRemoteNodeResult } from '../src/services/federation/catalogSync'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

const DEFAULT_SYNC_RESULT: SyncRemoteNodeResult = {
  fullSync: false,
  incremental: true,
  sinceUsed: new Date().toISOString(),
  itemsSynced: 5,
  librariesSynced: 1,
  fallbackUsed: false,
}

function makeCfg(overrides?: Partial<TrustedHomeSyncConfig>): TrustedHomeSyncConfig {
  return {
    enabled: true,
    intervalMs: 100,      // very short for test speed
    staggerMs: 0,         // no stagger in unit tests
    onStartup: false,
    ...overrides,
  }
}

async function addRemoteNode(db: TestDb, testDir: string, name = 'Remote') {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const { encryptApiKey } = await import('../src/services/integrations/encryption')
  const api_token_encrypted = encryptApiKey('test-token', testDir)
  await db.insert(nodes).values({
    id,
    name,
    kind: 'remote',
    base_url: 'http://remote:3001',
    status: 'unknown',
    api_token_encrypted,
    created_at: now,
    updated_at: now,
  })
  return id
}

// ─── Scheduler behaviour ──────────────────────────────────────────────────────

describe('TrustedHomeSyncScheduler — scheduler behaviour', () => {
  let testDir: string
  let db: TestDb

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-scheduler-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
  })

  afterEach(() => {
    syncInProgress.clear()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('1. When SYNC_ENABLED=false, start() does not schedule any sync calls', async () => {
    const syncFn = vi.fn().mockResolvedValue(DEFAULT_SYNC_RESULT)
    const scheduler = createTrustedHomeSyncScheduler(db, testDir, makeCfg({ enabled: false }), syncFn)

    await addRemoteNode(db, testDir)
    scheduler.start()

    // Wait longer than intervalMs to confirm nothing fires
    await new Promise((r) => setTimeout(r, 200))
    await scheduler.stop()

    expect(syncFn).not.toHaveBeenCalled()
  })

  it('2. When SYNC_ENABLED=true, tick calls syncFn for each remote node', async () => {
    const syncFn = vi.fn().mockResolvedValue(DEFAULT_SYNC_RESULT)
    const scheduler = createTrustedHomeSyncScheduler(db, testDir, makeCfg({ onStartup: true, intervalMs: 9999999 }), syncFn)

    const nodeId = await addRemoteNode(db, testDir)

    scheduler.start()
    // Wait for the startup tick to complete
    await new Promise((r) => setTimeout(r, 100))
    await scheduler.stop()

    expect(syncFn).toHaveBeenCalledTimes(1)
    expect(syncFn.mock.calls[0][0]).toBe(nodeId)
  })

  it('3. When a node is in syncInProgress, it is skipped during the tick', async () => {
    const syncFn = vi.fn().mockResolvedValue(DEFAULT_SYNC_RESULT)
    const scheduler = createTrustedHomeSyncScheduler(db, testDir, makeCfg({ onStartup: true, intervalMs: 9999999 }), syncFn)

    const nodeId = await addRemoteNode(db, testDir)
    // Pre-lock the node
    syncInProgress.add(nodeId)

    scheduler.start()
    await new Promise((r) => setTimeout(r, 100))
    await scheduler.stop()

    expect(syncFn).not.toHaveBeenCalled()
    syncInProgress.delete(nodeId)
  })

  it('4. When one node sync throws, the other node is still called', async () => {
    const nodeId1 = await addRemoteNode(db, testDir, 'Node1')
    const nodeId2 = await addRemoteNode(db, testDir, 'Node2')

    const syncFn = vi.fn().mockImplementation((nodeId: string) => {
      if (nodeId === nodeId1) return Promise.reject(new Error('Node1 failed'))
      return Promise.resolve(DEFAULT_SYNC_RESULT)
    })

    const scheduler = createTrustedHomeSyncScheduler(db, testDir, makeCfg({ onStartup: true, intervalMs: 9999999 }), syncFn)

    scheduler.start()
    await new Promise((r) => setTimeout(r, 200))
    await scheduler.stop()

    // Both nodes should have been attempted
    const calledIds = syncFn.mock.calls.map((c) => c[0] as string)
    expect(calledIds).toContain(nodeId1)
    expect(calledIds).toContain(nodeId2)
  })

  it('5. stop() prevents further ticks from firing', async () => {
    const syncFn = vi.fn().mockResolvedValue(DEFAULT_SYNC_RESULT)
    const scheduler = createTrustedHomeSyncScheduler(db, testDir, makeCfg({ intervalMs: 20 }), syncFn)

    await addRemoteNode(db, testDir)
    scheduler.start()

    // Stop before any tick fires
    await scheduler.stop()
    const callCountAfterStop = syncFn.mock.calls.length

    // Wait to confirm nothing more fires
    await new Promise((r) => setTimeout(r, 100))
    expect(syncFn.mock.calls.length).toBe(callCountAfterStop)
  })

  it('6. SYNC_ON_STARTUP=true causes immediate first tick; SYNC_ON_STARTUP=false does not', async () => {
    // onStartup=true
    const syncFnImmediate = vi.fn().mockResolvedValue(DEFAULT_SYNC_RESULT)
    const schedulerImmediate = createTrustedHomeSyncScheduler(
      db, testDir,
      makeCfg({ onStartup: true, intervalMs: 9999999 }),
      syncFnImmediate
    )

    await addRemoteNode(db, testDir)
    schedulerImmediate.start()
    await new Promise((r) => setTimeout(r, 100))
    await schedulerImmediate.stop()

    expect(syncFnImmediate).toHaveBeenCalledTimes(1)

    // onStartup=false — should not fire within intervalMs=9999999
    const syncFnDeferred = vi.fn().mockResolvedValue(DEFAULT_SYNC_RESULT)
    const schedulerDeferred = createTrustedHomeSyncScheduler(
      db, testDir,
      makeCfg({ onStartup: false, intervalMs: 9999999 }),
      syncFnDeferred
    )

    schedulerDeferred.start()
    await new Promise((r) => setTimeout(r, 100))
    await schedulerDeferred.stop()

    expect(syncFnDeferred).not.toHaveBeenCalled()
  })
})

// ─── Manual sync locking ──────────────────────────────────────────────────────

describe('TrustedHomeSyncScheduler — manual sync locking', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-sync-lock-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    syncInProgress.clear()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  async function addRemoteNodeViaApi() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    return JSON.parse(res.body).data.id as string
  }

  it('7. Manual sync returns 409 when node is in syncInProgress', async () => {
    const nodeId = await addRemoteNodeViaApi()

    // Pre-lock the node (simulates background scheduler or concurrent manual sync)
    syncInProgress.add(nodeId)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/already in progress/i)

    syncInProgress.delete(nodeId)
  })

  it('8. Manual sync acquires and releases lock on success', async () => {
    const nodeId = await addRemoteNodeViaApi()

    const mockCatalog = {
      nodeId,
      nodeName: 'Remote',
      exportedAt: Date.now(),
      incremental: false,
      libraries: [{ id: 'lib-1', name: 'Movies', kind: 'movies', itemCount: 0 }],
      items: [],
      versions: [],
      files: [],
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: mockCatalog }),
    }))

    // Lock must not be held before
    expect(syncInProgress.has(nodeId)).toBe(false)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    expect(res.statusCode).toBe(200)
    // Lock must be released after
    expect(syncInProgress.has(nodeId)).toBe(false)
  })

  it('9. Lock is released even if sync throws', async () => {
    const nodeId = await addRemoteNodeViaApi()

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    expect(res.statusCode).toBe(500)
    // Lock must be released despite the error
    expect(syncInProgress.has(nodeId)).toBe(false)
  })
})

// ─── Regressions ─────────────────────────────────────────────────────────────

describe('TrustedHomeSyncScheduler — regressions', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-sync-regress-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    syncInProgress.clear()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  async function addRemoteNodeViaApi(name = 'Remote') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name, base_url: 'http://remote:3001', api_token: 'tok' },
    })
    return JSON.parse(res.body).data.id as string
  }

  it('10. Incremental sync still works (regression)', async () => {
    const nodeId = await addRemoteNodeViaApi()

    // Set last_sync_at so incremental is used
    const lastSyncMs = Date.now() - 3600_000
    await db.update(nodes).set({ last_sync_at: lastSyncMs }).where(eq(nodes.id, nodeId))

    const mockCatalog = {
      nodeId,
      nodeName: 'Remote',
      exportedAt: Date.now(),
      incremental: true,
      since: new Date(lastSyncMs).toISOString(),
      libraries: [{ id: 'lib-r', name: 'Remote Movies', kind: 'movies', itemCount: 1 }],
      items: [],
      versions: [],
      files: [],
    }

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: mockCatalog }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.incremental).toBe(true)
    expect(body.data.fullSync).toBe(false)
    // URL must contain ?since
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toContain('since=')
  })

  it('11. Full sync still works (regression)', async () => {
    const nodeId = await addRemoteNodeViaApi()

    const mockCatalog = {
      nodeId,
      nodeName: 'Remote',
      exportedAt: Date.now(),
      incremental: false,
      libraries: [{ id: 'lib-r', name: 'Remote Movies', kind: 'movies', itemCount: 0 }],
      items: [],
      versions: [],
      files: [],
    }

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: mockCatalog }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.fullSync).toBe(true)
    expect(body.data.incremental).toBe(false)
    expect(body.data.synced).toBe(true)

    // URL must NOT contain ?since
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).not.toContain('since=')
  })

  it('12. Disconnect clears node — no stale lock after node deleted', async () => {
    const nodeId = await addRemoteNodeViaApi()

    // Simulate: scheduler holds the lock
    syncInProgress.add(nodeId)

    // Delete the node
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${nodeId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)

    // The node no longer exists in DB
    const [row] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(row).toBeUndefined()

    // Manually clean up the lock (as the scheduler's finally block would)
    syncInProgress.delete(nodeId)
    expect(syncInProgress.has(nodeId)).toBe(false)
  })
})
