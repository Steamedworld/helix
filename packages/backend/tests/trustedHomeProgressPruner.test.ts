/**
 * Trusted Home Progress Data Retention v1 — tests
 *
 * Covers:
 *   - config defaults and bounds
 *   - prunes old terminal outbox rows (synced/abandoned)
 *   - preserves pending / in_progress / failed (retrying) outbox rows
 *   - prunes stale remote progress rows; preserves recent
 *   - pruner failure is non-fatal (status flips to 'failed', no throw)
 *   - diagnostics are aggregate-only with no sensitive leakage
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
import { nodes, libraries, mediaItems, federatedProgressOutbox, remoteWatchProgress } from '../src/db/schema'
import {
  pruneProgressData,
  createProgressPruner,
  getProgressPruneState,
} from '../src/services/federation/trustedHomeProgressPruner'

process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET = 'progress-retention-refresh-secret'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const db = createDb(join(testDir, 'test.db'))
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}
type TestDb = ReturnType<typeof createDb>

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

async function insertNode(db: TestDb): Promise<string> {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await db.insert(nodes).values({ id, name: 'Peer', kind: 'remote', base_url: 'http://peer:3001', status: 'online', created_at: now, updated_at: now })
  return id
}

async function insertOutbox(db: TestDb, nodeId: string, status: 'pending' | 'in_progress' | 'synced' | 'failed' | 'abandoned', updatedAt: string) {
  await db.insert(federatedProgressOutbox).values({
    id: crypto.randomUUID(),
    node_id: nodeId,
    media_id: crypto.randomUUID(),
    client_event_id: crypto.randomUUID().slice(0, 16),
    position_seconds: 1000,
    duration_seconds: 7200,
    watched: 0,
    local_updated_at: updatedAt,
    status,
    next_attempt_at: updatedAt,
    created_at: updatedAt,
    updated_at: updatedAt,
  })
}

async function insertItem(db: TestDb, nodeId: string): Promise<string> {
  const now = new Date().toISOString()
  const libId = crypto.randomUUID()
  await db.insert(libraries).values({
    id: libId, node_id: nodeId, name: 'Lib', kind: 'movies',
    root_path: `remote://${nodeId}`, scan_status: 'idle', created_at: now, updated_at: now,
  })
  const itemId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: itemId, library_id: libId, kind: 'movie', title: 'Item',
    sort_title: 'item', metadata_status: 'matched', created_at: now, updated_at: now,
  })
  return itemId
}

async function insertRemoteProgress(db: TestDb, nodeId: string, updatedAt: string, hash: string) {
  const itemId = await insertItem(db, nodeId)
  await db.insert(remoteWatchProgress).values({
    id: crypto.randomUUID(),
    source_node_id: nodeId,
    media_item_id: itemId,
    remote_viewer_hash: hash,
    viewer_identity_kind: 'node',
    position_seconds: 1000,
    duration_seconds: 7200,
    watched: 0,
    updated_at: updatedAt,
    client_event_id: crypto.randomUUID().slice(0, 16),
    created_at: updatedAt,
  })
}

describe('config defaults and bounds', () => {
  const orig = { ...process.env }
  afterEach(() => {
    vi.resetModules()
    Object.keys(process.env).forEach((k) => { if (!(k in orig)) delete process.env[k] })
    Object.assign(process.env, orig)
  })

  it('defaults to 30 (outbox) and 365 (remote progress)', async () => {
    vi.resetModules()
    delete process.env.TRUSTED_HOME_PROGRESS_OUTBOX_RETENTION_DAYS
    delete process.env.TRUSTED_HOME_REMOTE_PROGRESS_RETENTION_DAYS
    const { config } = await import('../src/config')
    expect(config.progressOutboxRetentionDays).toBe(30)
    expect(config.remoteProgressRetentionDays).toBe(365)
  })

  it('clamps out-of-range and invalid values to bounds / default', async () => {
    vi.resetModules()
    process.env.TRUSTED_HOME_PROGRESS_OUTBOX_RETENTION_DAYS = '999999'
    process.env.TRUSTED_HOME_REMOTE_PROGRESS_RETENTION_DAYS = '0'
    const { config } = await import('../src/config')
    expect(config.progressOutboxRetentionDays).toBe(3650) // clamped to max
    expect(config.remoteProgressRetentionDays).toBe(1) // clamped to min

    vi.resetModules()
    process.env.TRUSTED_HOME_PROGRESS_OUTBOX_RETENTION_DAYS = 'not-a-number'
    const { config: c2 } = await import('../src/config')
    expect(c2.progressOutboxRetentionDays).toBe(30) // NaN → default
  })
})

describe('pruneProgressData', () => {
  let testDir: string
  let db: TestDb

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-progress-prune-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
  })
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('prunes old terminal outbox rows but preserves active/retrying rows', async () => {
    const nodeId = await insertNode(db)
    // Old terminal rows (should be pruned)
    await insertOutbox(db, nodeId, 'synced', daysAgo(40))
    await insertOutbox(db, nodeId, 'abandoned', daysAgo(40))
    // Old active/retrying rows (must be preserved)
    await insertOutbox(db, nodeId, 'pending', daysAgo(40))
    await insertOutbox(db, nodeId, 'in_progress', daysAgo(40))
    await insertOutbox(db, nodeId, 'failed', daysAgo(40))
    // Recent terminal row (must be preserved)
    await insertOutbox(db, nodeId, 'synced', daysAgo(1))

    const { outboxPruned } = await pruneProgressData(db, { outboxRetentionDays: 30, remoteProgressRetentionDays: 365 })
    expect(outboxPruned).toBe(2)

    const remaining = await db.select().from(federatedProgressOutbox)
    const statuses = remaining.map((r) => r.status).sort()
    expect(statuses).toEqual(['failed', 'in_progress', 'pending', 'synced']) // recent synced survived
  })

  it('prunes stale remote progress but preserves recent rows', async () => {
    const nodeId = await insertNode(db)
    const recentTs = daysAgo(10)
    await insertRemoteProgress(db, nodeId, daysAgo(400), 'a'.repeat(32)) // stale
    await insertRemoteProgress(db, nodeId, recentTs, 'b'.repeat(32))     // recent

    const { remoteProgressPruned } = await pruneProgressData(db, { outboxRetentionDays: 30, remoteProgressRetentionDays: 365 })
    expect(remoteProgressPruned).toBe(1)

    const remaining = await db.select().from(remoteWatchProgress)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].updated_at).toBe(recentTs)
  })
})

describe('pruner failure is non-fatal', () => {
  it('records status=failed without throwing when the delete fails', async () => {
    const brokenDb = { delete: () => { throw new Error('boom') } } as unknown as TestDb
    const pruner = createProgressPruner(brokenDb, { outboxRetentionDays: 30, remoteProgressRetentionDays: 365 })
    pruner.start()
    await pruner.stop() // awaits the in-flight tick
    expect(getProgressPruneState().lastProgressPruneStatus).toBe('failed')
  })
})

describe('diagnostics — progress retention aggregate, no leakage', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-progress-diag-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    const localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })
  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('exposes aggregate retention fields only and never a viewer hash', async () => {
    const nodeId = await insertNode(db)
    const secretHash = 'deadbeef'.repeat(4) // 32 hex
    await insertRemoteProgress(db, nodeId, daysAgo(5), secretHash)

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/sync-diagnostics', headers: { Cookie: adminCookie } })
    expect(res.statusCode).toBe(200)
    const pr = JSON.parse(res.body).data.progressRetention
    expect(pr).toBeDefined()
    expect(pr.progressOutboxRetentionDays).toBe(30)
    expect(pr.remoteProgressRetentionDays).toBe(365)
    expect(typeof pr.outboxPruneCutoff).toBe('string')
    expect(typeof pr.remoteProgressPruneCutoff).toBe('string')
    expect(['ok', 'failed', 'not_run']).toContain(pr.lastProgressPruneStatus)
    // The stored viewer hash must never appear in diagnostics
    expect(res.body).not.toContain(secretHash)
  })
})
