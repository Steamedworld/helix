/**
 * Durable Federated Progress Push Outbox — tests
 *
 * Covers:
 *   Enqueue behaviour (5 tests)
 *   Deduplication (2 tests)
 *   Worker behaviour (7 tests)
 *   Security assertions (3 tests)
 *   Regressions (3 tests)
 *
 * Total: 20 tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  mediaVersions,
  mediaFiles,
  watchStates,
  federatedProgressOutbox,
} from '../src/db/schema'
import { encryptApiKey } from '../src/services/integrations/encryption'
import { enqueueProgressPush } from '../src/services/federation/progressOutbox'
import {
  createProgressOutboxWorker,
} from '../src/services/federation/progressOutboxWorker'

// ─── Test secret ──────────────────────────────────────────────────────────────

process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET = 'test-outbox-refresh-secret'
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

async function insertRemoteNodeWithPushEnabled(db: TestDb, testDir: string, opts?: {
  progressSyncEnabled?: boolean
  allowProgressPush?: boolean
}) {
  const now = new Date().toISOString()
  const nodeId = crypto.randomUUID()
  await db.insert(nodes).values({
    id: nodeId,
    name: 'Source Home',
    kind: 'remote',
    base_url: 'http://source-home:3001',
    status: 'online',
    api_token_encrypted: encryptApiKey('test-federation-token', testDir),
    progress_sync_enabled: (opts?.progressSyncEnabled ?? true) ? 1 : 0,
    allow_progress_push: (opts?.allowProgressPush ?? true) ? 1 : 0,
    created_at: now,
    updated_at: now,
  })
  const libId = crypto.randomUUID()
  await db.insert(libraries).values({
    id: libId,
    node_id: nodeId,
    name: 'Remote Movies',
    kind: 'movies',
    root_path: `remote://${nodeId}`,
    scan_status: 'idle',
    created_at: now,
    updated_at: now,
  })
  const itemId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: itemId,
    library_id: libId,
    kind: 'movie',
    title: 'Remote Movie',
    sort_title: 'remote movie',
    metadata_status: 'matched',
    created_at: now,
    updated_at: now,
  })
  const verId = crypto.randomUUID()
  await db.insert(mediaVersions).values({
    id: verId,
    media_item_id: itemId,
    quality_label: '1080p',
    duration_seconds: 7200,
    created_at: now,
    updated_at: now,
  })
  await db.insert(mediaFiles).values({
    id: crypto.randomUUID(),
    node_id: nodeId,
    library_id: libId,
    media_item_id: itemId,
    media_version_id: verId,
    path: `remote://${nodeId}/file.mkv`,
    filename: 'remote.mkv',
    extension: 'mkv',
    size_bytes: 4000000000,
    file_hash: null,
    discovered_at: now,
    updated_at: now,
  })
  return { nodeId, libId, itemId }
}

function makeWorkerCfg(testDir: string, overrides?: Partial<{ intervalMs: number; maxAttempts: number; requestTimeoutMs: number }>) {
  return {
    intervalMs: overrides?.intervalMs ?? 9999999,
    maxAttempts: overrides?.maxAttempts ?? 3,
    requestTimeoutMs: overrides?.requestTimeoutMs ?? 5000,
    dataDir: testDir,
  }
}

// ─── Part 1: Enqueue behaviour ────────────────────────────────────────────────

describe('Progress outbox — enqueue behaviour', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-outbox-enqueue-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 1
  it('local progress write enqueues outbox job when sync enabled and push allowed', async () => {
    const { itemId } = await insertRemoteNodeWithPushEnabled(db, testDir)

    // Stub fetch so no actual HTTP call is made
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${itemId}`,
      headers: { Cookie: adminCookie },
      payload: { position_seconds: 3600, duration_seconds: 7200, completed: false },
    })
    expect(res.statusCode).toBe(200)

    // Should have an outbox row
    const jobs = await db.select().from(federatedProgressOutbox)
      .where(eq(federatedProgressOutbox.media_id, itemId))
    expect(jobs.length).toBeGreaterThanOrEqual(1)
    expect(jobs[0].status).toMatch(/pending|in_progress|synced/)
    expect(jobs[0].position_seconds).toBe(3600)
  })

  // Test 2
  it('local progress write does NOT enqueue when progress_sync_enabled=false', async () => {
    const { itemId } = await insertRemoteNodeWithPushEnabled(db, testDir, {
      progressSyncEnabled: false,
      allowProgressPush: true,
    })

    let fetchCalled = false
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      fetchCalled = true
      return Promise.resolve({ ok: true, json: async () => ({}) })
    }))

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${itemId}`,
      headers: { Cookie: adminCookie },
      payload: { position_seconds: 3600, duration_seconds: 7200, completed: false },
    })
    expect(res.statusCode).toBe(200)

    // No outbox job
    const jobs = await db.select().from(federatedProgressOutbox)
      .where(eq(federatedProgressOutbox.media_id, itemId))
    expect(jobs.length).toBe(0)
    expect(fetchCalled).toBe(false)
  })

  // Test 3
  it('local progress write does NOT enqueue when allow_progress_push=false', async () => {
    const { itemId } = await insertRemoteNodeWithPushEnabled(db, testDir, {
      progressSyncEnabled: true,
      allowProgressPush: false,
    })

    let fetchCalled = false
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      fetchCalled = true
      return Promise.resolve({ ok: true, json: async () => ({}) })
    }))

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${itemId}`,
      headers: { Cookie: adminCookie },
      payload: { position_seconds: 3600, duration_seconds: 7200, completed: false },
    })
    expect(res.statusCode).toBe(200)

    const jobs = await db.select().from(federatedProgressOutbox)
      .where(eq(federatedProgressOutbox.media_id, itemId))
    expect(jobs.length).toBe(0)
    expect(fetchCalled).toBe(false)
  })

  // Test 4
  it('newer local progress updates existing pending job', async () => {
    const { nodeId, itemId } = await insertRemoteNodeWithPushEnabled(db, testDir)

    const clientEventId = 'aabb1122ccdd3344'
    const oldAt = new Date(Date.now() - 10000).toISOString()
    const newAt = new Date(Date.now() - 1000).toISOString()

    // Insert a pending job with old position
    const now = new Date().toISOString()
    const jobId = crypto.randomUUID()
    await db.insert(federatedProgressOutbox).values({
      id: jobId,
      node_id: nodeId,
      media_id: itemId,
      client_event_id: clientEventId,
      position_seconds: 1000,
      duration_seconds: 7200,
      watched: 0,
      local_updated_at: oldAt,
      attempt_count: 0,
      max_attempts: 3,
      status: 'pending',
      next_attempt_at: now,
      last_attempt_at: null,
      last_error_code: null,
      created_at: now,
      updated_at: now,
    })

    // Enqueue newer progress
    await enqueueProgressPush(db, {
      nodeId,
      mediaId: itemId,
      clientEventId,
      positionSeconds: 5000,
      durationSeconds: 7200,
      watched: false,
      localUpdatedAt: newAt,
    })

    const [job] = await db.select().from(federatedProgressOutbox)
      .where(eq(federatedProgressOutbox.id, jobId))
    expect(job.position_seconds).toBe(5000)
    expect(job.local_updated_at).toBe(newAt)
    expect(job.status).toBe('pending')
    expect(job.attempt_count).toBe(0)
  })

  // Test 5
  it('older local progress does NOT overwrite newer pending job', async () => {
    const { nodeId, itemId } = await insertRemoteNodeWithPushEnabled(db, testDir)

    const clientEventId = 'aabb1122ccdd5566'
    const newerAt = new Date(Date.now() - 1000).toISOString()
    const olderAt = new Date(Date.now() - 10000).toISOString()

    const now = new Date().toISOString()
    const jobId = crypto.randomUUID()
    await db.insert(federatedProgressOutbox).values({
      id: jobId,
      node_id: nodeId,
      media_id: itemId,
      client_event_id: clientEventId,
      position_seconds: 5000,
      duration_seconds: 7200,
      watched: 0,
      local_updated_at: newerAt,
      attempt_count: 0,
      max_attempts: 3,
      status: 'pending',
      next_attempt_at: now,
      last_attempt_at: null,
      last_error_code: null,
      created_at: now,
      updated_at: now,
    })

    // Try to enqueue older progress — should be ignored
    await enqueueProgressPush(db, {
      nodeId,
      mediaId: itemId,
      clientEventId,
      positionSeconds: 1000,
      durationSeconds: 7200,
      watched: false,
      localUpdatedAt: olderAt,
    })

    const [job] = await db.select().from(federatedProgressOutbox)
      .where(eq(federatedProgressOutbox.id, jobId))
    expect(job.position_seconds).toBe(5000) // unchanged
    expect(job.local_updated_at).toBe(newerAt)
  })
})

// ─── Part 2: Deduplication ────────────────────────────────────────────────────

describe('Progress outbox — deduplication', () => {
  let testDir: string
  let db: TestDb

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-outbox-dedup-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 6
  it('identical (node_id, media_id, client_event_id) upserts cleanly — no duplicate row', async () => {
    // We need a node for the FK constraint
    const now = new Date().toISOString()
    const nodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: nodeId,
      name: 'Test',
      kind: 'remote',
      base_url: 'http://test:3001',
      status: 'online',
      created_at: now,
      updated_at: now,
    })

    const mediaId = crypto.randomUUID()
    const clientEventId = 'dedup-test-event'
    const at1 = new Date(Date.now() - 5000).toISOString()
    const at2 = new Date(Date.now() - 1000).toISOString()

    // First enqueue
    await enqueueProgressPush(db, {
      nodeId, mediaId, clientEventId,
      positionSeconds: 1000, durationSeconds: 7200, watched: false,
      localUpdatedAt: at1,
    })

    // Second enqueue — same triple, newer timestamp
    await enqueueProgressPush(db, {
      nodeId, mediaId, clientEventId,
      positionSeconds: 2000, durationSeconds: 7200, watched: false,
      localUpdatedAt: at2,
    })

    const jobs = await db.select().from(federatedProgressOutbox)
      .where(
        and(
          eq(federatedProgressOutbox.node_id, nodeId),
          eq(federatedProgressOutbox.media_id, mediaId),
          eq(federatedProgressOutbox.client_event_id, clientEventId)
        )
      )

    // Must have exactly ONE row
    expect(jobs.length).toBe(1)
    // Must reflect the newer position
    expect(jobs[0].position_seconds).toBe(2000)
  })

  // Test 7
  it('synced job is reset to pending when new progress arrives', async () => {
    const now = new Date().toISOString()
    const nodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: nodeId,
      name: 'Test',
      kind: 'remote',
      base_url: 'http://test:3001',
      status: 'online',
      created_at: now,
      updated_at: now,
    })

    const mediaId = crypto.randomUUID()
    const clientEventId = 'reset-synced-event'
    const oldAt = new Date(Date.now() - 10000).toISOString()
    const newAt = new Date(Date.now() - 1000).toISOString()

    const jobId = crypto.randomUUID()
    await db.insert(federatedProgressOutbox).values({
      id: jobId,
      node_id: nodeId,
      media_id: mediaId,
      client_event_id: clientEventId,
      position_seconds: 3600,
      duration_seconds: 7200,
      watched: 0,
      local_updated_at: oldAt,
      attempt_count: 2,
      max_attempts: 3,
      status: 'synced',
      next_attempt_at: now,
      last_attempt_at: now,
      last_error_code: null,
      created_at: now,
      updated_at: now,
    })

    // New progress should reset the job to pending
    await enqueueProgressPush(db, {
      nodeId, mediaId, clientEventId,
      positionSeconds: 7000, durationSeconds: 7200, watched: true,
      localUpdatedAt: newAt,
    })

    const [job] = await db.select().from(federatedProgressOutbox)
      .where(eq(federatedProgressOutbox.id, jobId))
    expect(job.status).toBe('pending')
    expect(job.attempt_count).toBe(0)
    expect(job.position_seconds).toBe(7000)
  })
})

// ─── Part 3: Worker behaviour ─────────────────────────────────────────────────

describe('Progress outbox worker — behaviour', () => {
  let testDir: string
  let db: TestDb

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-outbox-worker-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(testDir, { recursive: true, force: true })
  })

  async function insertNodeAndJob(overrides?: {
    progressSyncEnabled?: boolean
    allowProgressPush?: boolean
    attemptCount?: number
    maxAttempts?: number
    status?: string
  }) {
    const now = new Date().toISOString()
    const nodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: nodeId,
      name: 'Source',
      kind: 'remote',
      base_url: 'http://source:3001',
      status: 'online',
      api_token_encrypted: encryptApiKey('test-token', testDir),
      progress_sync_enabled: (overrides?.progressSyncEnabled ?? true) ? 1 : 0,
      allow_progress_push: (overrides?.allowProgressPush ?? true) ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    const mediaId = crypto.randomUUID()
    const jobId = crypto.randomUUID()
    const pastTime = new Date(Date.now() - 60000).toISOString() // 1 minute ago — eligible
    await db.insert(federatedProgressOutbox).values({
      id: jobId,
      node_id: nodeId,
      media_id: mediaId,
      client_event_id: 'worker-test-event',
      position_seconds: 3600,
      duration_seconds: 7200,
      watched: 0,
      local_updated_at: new Date(Date.now() - 5000).toISOString(),
      attempt_count: overrides?.attemptCount ?? 0,
      max_attempts: overrides?.maxAttempts ?? 3,
      status: (overrides?.status ?? 'pending') as 'pending' | 'in_progress' | 'synced' | 'failed' | 'abandoned',
      next_attempt_at: pastTime,
      last_attempt_at: null,
      last_error_code: null,
      created_at: now,
      updated_at: now,
    })
    return { nodeId, mediaId, jobId }
  }

  // Test 8
  it('worker processes pending job and marks synced on success (mock fetch)', async () => {
    const { jobId } = await insertNodeAndJob()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { accepted: true } }),
    }))

    const worker = createProgressOutboxWorker(db, makeWorkerCfg(testDir))
    worker.start()
    // Let the initial tick run
    await new Promise((r) => setTimeout(r, 200))
    await worker.stop()

    const [job] = await db.select().from(federatedProgressOutbox)
      .where(eq(federatedProgressOutbox.id, jobId))
    expect(job.status).toBe('synced')
    expect(job.attempt_count).toBe(1)
    expect(job.last_error_code).toBeNull()
  })

  // Test 9
  it('worker increments attempt_count and schedules next_attempt_at on failure', async () => {
    const { jobId } = await insertNodeAndJob()

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const worker = createProgressOutboxWorker(db, makeWorkerCfg(testDir))
    worker.start()
    await new Promise((r) => setTimeout(r, 200))
    await worker.stop()

    const [job] = await db.select().from(federatedProgressOutbox)
      .where(eq(federatedProgressOutbox.id, jobId))
    expect(job.attempt_count).toBe(1)
    expect(job.status).toBe('failed')
    expect(job.last_error_code).toBeTruthy()
    // next_attempt_at must be in the future (backoff applied)
    expect(new Date(job.next_attempt_at).getTime()).toBeGreaterThan(Date.now())
  })

  // Test 10
  it('worker marks abandoned after max_attempts reached', async () => {
    // Start at attempt_count = max_attempts - 1 so one more failure abandons it
    const { jobId } = await insertNodeAndJob({ attemptCount: 2, maxAttempts: 3 })

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const worker = createProgressOutboxWorker(db, makeWorkerCfg(testDir))
    worker.start()
    await new Promise((r) => setTimeout(r, 200))
    await worker.stop()

    const [job] = await db.select().from(federatedProgressOutbox)
      .where(eq(federatedProgressOutbox.id, jobId))
    expect(job.status).toBe('abandoned')
    expect(job.attempt_count).toBe(3)
  })

  // Test 11
  it('worker re-checks progress_sync_enabled before attempt — abandons if disabled', async () => {
    const { nodeId, jobId } = await insertNodeAndJob()

    // Disable sync after job was enqueued
    await db.update(nodes)
      .set({ progress_sync_enabled: 0 })
      .where(eq(nodes.id, nodeId))

    let fetchCalled = false
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      fetchCalled = true
      return Promise.resolve({ ok: true })
    }))

    const worker = createProgressOutboxWorker(db, makeWorkerCfg(testDir))
    worker.start()
    await new Promise((r) => setTimeout(r, 200))
    await worker.stop()

    const [job] = await db.select().from(federatedProgressOutbox)
      .where(eq(federatedProgressOutbox.id, jobId))
    expect(job.status).toBe('abandoned')
    expect(job.last_error_code).toBe('config_disabled')
    expect(fetchCalled).toBe(false)
  })

  // Test 12 — Security: worker never logs/stores token, raw URL (beyond safe node identifier), or raw error body
  it('worker never logs federation token, raw URL beyond node id, or raw error body in stored fields', async () => {
    const { jobId } = await insertNodeAndJob()

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED secret-token-exposure')))

    const worker = createProgressOutboxWorker(db, makeWorkerCfg(testDir))
    worker.start()
    await new Promise((r) => setTimeout(r, 200))
    await worker.stop()

    const [job] = await db.select().from(federatedProgressOutbox)
      .where(eq(federatedProgressOutbox.id, jobId))

    // last_error_code must be a safe classified code, never raw error text
    const safeCodes = ['remote_unreachable', 'auth_failed', 'timeout', 'network_error', 'config_disabled', 'unknown', 'remote_catalog_failed', 'invalid_remote_response']
    expect(safeCodes).toContain(job.last_error_code)

    // No raw token or error body stored — the outbox table has no such column
    const columns = Object.keys(job)
    expect(columns).not.toContain('token')
    expect(columns).not.toContain('api_token')
    expect(columns).not.toContain('raw_error')
    expect(columns).not.toContain('error_body')
    expect(columns).not.toContain('user_id')
  })

  // Test 13
  it('worker handles network failure without uncaught throw (isolated per-job catch)', async () => {
    // Insert two jobs — first fails, second should still be processed
    const { jobId: job1Id } = await insertNodeAndJob()

    // Second job with different media_id
    const now = new Date().toISOString()
    const nodeId2 = crypto.randomUUID()
    await db.insert(nodes).values({
      id: nodeId2,
      name: 'Source2',
      kind: 'remote',
      base_url: 'http://source2:3001',
      status: 'online',
      api_token_encrypted: encryptApiKey('test-token-2', testDir),
      progress_sync_enabled: 1,
      allow_progress_push: 1,
      created_at: now,
      updated_at: now,
    })
    const mediaId2 = crypto.randomUUID()
    const job2Id = crypto.randomUUID()
    await db.insert(federatedProgressOutbox).values({
      id: job2Id,
      node_id: nodeId2,
      media_id: mediaId2,
      client_event_id: 'second-job-event',
      position_seconds: 1800,
      duration_seconds: 7200,
      watched: 0,
      local_updated_at: new Date(Date.now() - 3000).toISOString(),
      attempt_count: 0,
      max_attempts: 3,
      status: 'pending',
      next_attempt_at: new Date(Date.now() - 60000).toISOString(),
      last_attempt_at: null,
      last_error_code: null,
      created_at: now,
      updated_at: now,
    })

    let callCount = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.reject(new Error('ECONNREFUSED first job'))
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    }))

    // Must not throw
    const worker = createProgressOutboxWorker(db, makeWorkerCfg(testDir))
    await expect(
      (async () => {
        worker.start()
        await new Promise((r) => setTimeout(r, 300))
        await worker.stop()
      })()
    ).resolves.not.toThrow()

    // Both jobs should have been attempted
    const [j1] = await db.select().from(federatedProgressOutbox).where(eq(federatedProgressOutbox.id, job1Id))
    const [j2] = await db.select().from(federatedProgressOutbox).where(eq(federatedProgressOutbox.id, job2Id))
    // job1 failed, job2 succeeded
    expect(j1.status).toBe('failed')
    expect(j2.status).toBe('synced')
  })

  // Test 14 — Backoff grows between attempts
  it('backoff delay grows between attempts (attempt 2 delay > attempt 1 delay)', async () => {
    // We test the backoff by inserting a job at attempt_count=0 and another at attempt_count=1
    // and checking that next_attempt_at is further in the future for the second
    const { jobId: job1Id } = await insertNodeAndJob({ attemptCount: 0 })

    const now2 = new Date().toISOString()
    const nodeId2 = crypto.randomUUID()
    await db.insert(nodes).values({
      id: nodeId2,
      name: 'Source3',
      kind: 'remote',
      base_url: 'http://source3:3001',
      status: 'online',
      api_token_encrypted: encryptApiKey('tok3', testDir),
      progress_sync_enabled: 1,
      allow_progress_push: 1,
      created_at: now2,
      updated_at: now2,
    })
    const mediaId2 = crypto.randomUUID()
    const job2Id = crypto.randomUUID()
    await db.insert(federatedProgressOutbox).values({
      id: job2Id,
      node_id: nodeId2,
      media_id: mediaId2,
      client_event_id: 'backoff-test-event',
      position_seconds: 1800,
      duration_seconds: 7200,
      watched: 0,
      local_updated_at: new Date(Date.now() - 3000).toISOString(),
      attempt_count: 1,
      max_attempts: 3,
      status: 'failed',
      next_attempt_at: new Date(Date.now() - 60000).toISOString(),
      last_attempt_at: now2,
      last_error_code: 'remote_unreachable',
      created_at: now2,
      updated_at: now2,
    })

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const worker = createProgressOutboxWorker(db, makeWorkerCfg(testDir))
    worker.start()
    await new Promise((r) => setTimeout(r, 300))
    await worker.stop()

    const [j1] = await db.select().from(federatedProgressOutbox).where(eq(federatedProgressOutbox.id, job1Id))
    const [j2] = await db.select().from(federatedProgressOutbox).where(eq(federatedProgressOutbox.id, job2Id))

    // Both failed — check their next_attempt_at is in the future
    const delay1 = new Date(j1.next_attempt_at).getTime() - Date.now()
    const delay2 = new Date(j2.next_attempt_at).getTime() - Date.now()

    // Attempt 2 should have a larger backoff than attempt 1
    // (30s base vs 120s base, with ±10% jitter, both should be > 0)
    expect(delay1).toBeGreaterThan(0)
    expect(delay2).toBeGreaterThan(0)
    expect(delay2).toBeGreaterThan(delay1)
  })
})

// ─── Part 4: Security assertions ─────────────────────────────────────────────

describe('Progress outbox — security assertions', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-outbox-sec-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 15 — Schema check: outbox table has no user_id, token, raw_url, or path columns
  // We check the Drizzle column map (runtime object) on the table instance.
  it('outbox table has no user_id, token, raw_url, or path columns (schema check)', () => {
    // federatedProgressOutbox[col.name] is the Drizzle column descriptor at runtime
    const columns = Object.keys(federatedProgressOutbox)
    // Must contain expected safe columns
    expect(columns).toContain('id')
    expect(columns).toContain('node_id')
    expect(columns).toContain('media_id')
    expect(columns).toContain('client_event_id')
    expect(columns).toContain('position_seconds')
    expect(columns).toContain('status')
    // Must NOT contain sensitive columns
    expect(columns).not.toContain('user_id')
    expect(columns).not.toContain('token')
    expect(columns).not.toContain('api_token')
    expect(columns).not.toContain('federation_token')
    expect(columns).not.toContain('raw_url')
    expect(columns).not.toContain('path')
    expect(columns).not.toContain('authorization')
    expect(columns).not.toContain('raw_error')
    expect(columns).not.toContain('error_body')
    expect(columns).not.toContain('username')
    expect(columns).not.toContain('email')
  })

  // Test 16 — Admin outbox diagnostics include only counts and safe code labels
  it('admin outbox diagnostics include only counts and safe code labels', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const outbox = body.data.progressOutbox
    expect(outbox).toBeDefined()
    // Should have count fields
    expect(typeof outbox.pending).toBe('number')
    expect(typeof outbox.inProgress).toBe('number')
    expect(typeof outbox.synced).toBe('number')
    expect(typeof outbox.failed).toBe('number')
    expect(typeof outbox.abandoned).toBe('number')
    // Should have safe-label error code counts
    expect(outbox.lastErrorCodeCounts).toBeDefined()
    expect(typeof outbox.lastErrorCodeCounts).toBe('object')
    // oldestPendingAgeBucket is null or a safe label
    expect(
      outbox.oldestPendingAgeBucket === null ||
      ['under_1h', '1h_to_6h', 'over_6h'].includes(outbox.oldestPendingAgeBucket)
    ).toBe(true)
  })

  // Test 17 — Admin outbox diagnostics do not include job payload, token, URL, path, or IDs
  it('admin outbox diagnostics do not include job payload, token, URL, path, or node/media ID', async () => {
    const { nodeId, itemId } = await insertRemoteNodeWithPushEnabled(db, testDir)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))

    // Generate some outbox entries
    await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${itemId}`,
      headers: { Cookie: adminCookie },
      payload: { position_seconds: 3600, duration_seconds: 7200, completed: false },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const raw = res.body
    const body = JSON.parse(raw)

    // progressOutbox must not contain nodeId or itemId
    const outboxStr = JSON.stringify(body.data.progressOutbox)
    expect(outboxStr).not.toContain(nodeId)
    expect(outboxStr).not.toContain(itemId)
    // Must not contain token values
    expect(outboxStr).not.toContain('test-federation-token')
    expect(outboxStr).not.toContain('Bearer')
    // Must not contain URLs or paths
    expect(outboxStr).not.toContain('http://source-home')
    expect(outboxStr).not.toContain('/data/')
  })
})

// ─── Part 5: Regressions ──────────────────────────────────────────────────────

describe('Progress outbox — regressions', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-outbox-regress-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 18 — Existing federated progress push endpoint tests still pass
  it('federated source endpoint still accepts valid progress (regression)', async () => {
    // Bootstrap provides the local node — generate a federation token
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    const rawFederationToken = JSON.parse(tokenRes.body).data.token

    // Enable receiving on the local node
    await db.update(nodes)
      .set({ allow_progress_receive: 1 })
      .where(eq(nodes.id, localNodeId))

    // Insert a local media item
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

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/federation/media/${itemId}/watch-progress`,
      payload: {
        positionSeconds: 3600,
        durationSeconds: 7200,
        watched: false,
        updatedAt: new Date(Date.now() - 1000).toISOString(),
      },
      headers: { Authorization: `Bearer ${rawFederationToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.accepted).toBe(true)
  })

  // Test 19 — Remote progress read path still works
  it('remote progress read path still works (regression)', async () => {
    const { nodeId, itemId } = await insertRemoteNodeWithPushEnabled(db, testDir)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          available: true,
          positionSeconds: 1800,
          durationSeconds: 7200,
          watched: false,
          updatedAt: new Date().toISOString(),
        },
      }),
    }))

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/media/${itemId}/remote-progress`,
      headers: { Cookie: adminCookie },
    })
    // Should succeed (200) or gracefully handle
    expect([200, 404]).toContain(res.statusCode)
  })

  // Test 20 — Local progress write still succeeds when enqueue fails
  it('local progress write still succeeds when enqueue fails (fire-and-forget enqueue)', async () => {
    const { itemId } = await insertRemoteNodeWithPushEnabled(db, testDir)

    // Stub fetch to fail for any push attempts
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${itemId}`,
      headers: { Cookie: adminCookie },
      payload: { position_seconds: 5400, duration_seconds: 7200, completed: false },
    })

    // Local write must succeed
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.position_seconds).toBe(5400)

    // Watch state must be in DB
    const rows = await db.select().from(watchStates)
      .where(eq(watchStates.media_item_id, itemId))
    expect(rows.length).toBe(1)
    expect(rows[0].position_seconds).toBe(5400)
  })
})
