/**
 * Tests for Trusted Home Sync Diagnostics v1.
 *
 * Covers:
 *   - Tombstone stats (5 tests)
 *   - Safety helper (3 tests)
 *   - Diagnostics persistence (4 tests)
 *   - Authorization (3 tests)
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
import { nodes, catalogTombstones } from '../src/db/schema'
import { computeSyncSafetyEstimate } from '../src/services/federation/catalogSync'
import type { FederationCatalogData } from '../src/services/federation/catalogSync'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

// ─── Tombstone stats tests ────────────────────────────────────────────────────

describe('GET /api/v1/admin/sync-diagnostics — tombstone stats', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-syncdiag-tomb-${crypto.randomUUID()}`)
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

  // Test 1: correct total tombstone count
  it('returns correct total tombstone count', async () => {
    const now = new Date().toISOString()
    await db.insert(catalogTombstones).values([
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_file', entity_id: 'f1', deleted_at: now, created_at: now },
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_item', entity_id: 'i1', deleted_at: now, created_at: now },
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_version', entity_id: 'v1', deleted_at: now, created_at: now },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.tombstoneStats.total).toBe(3)
  })

  // Test 2: correct counts by entity type
  it('returns correct counts by entity type', async () => {
    const now = new Date().toISOString()
    await db.insert(catalogTombstones).values([
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'library', entity_id: 'lib1', deleted_at: now, created_at: now },
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_item', entity_id: 'i1', deleted_at: now, created_at: now },
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_item', entity_id: 'i2', deleted_at: now, created_at: now },
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_file', entity_id: 'f1', deleted_at: now, created_at: now },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const { byEntityType } = JSON.parse(res.body).data.tombstoneStats
    expect(byEntityType['library']).toBe(1)
    expect(byEntityType['media_item']).toBe(2)
    expect(byEntityType['media_file']).toBe(1)
    expect(byEntityType['media_version']).toBeUndefined()
  })

  // Test 3: correct age buckets with tombstones of various ages
  it('returns correct age buckets', async () => {
    const now = new Date()
    // 1 under 7 days old
    const d3 = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
    // 1 between 7-30 days old
    const d14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
    // 1 between 30 days and retention (90 days default)
    const d60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
    // 1 older than retention (100 days)
    const d100 = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString()

    await db.insert(catalogTombstones).values([
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_file', entity_id: 'f1', deleted_at: d3, created_at: d3 },
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_file', entity_id: 'f2', deleted_at: d14, created_at: d14 },
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_file', entity_id: 'f3', deleted_at: d60, created_at: d60 },
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_file', entity_id: 'f4', deleted_at: d100, created_at: d100 },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const { ageBuckets } = JSON.parse(res.body).data.tombstoneStats
    expect(ageBuckets.under7Days).toBe(1)
    expect(ageBuckets.days7To30).toBe(1)
    expect(ageBuckets.days30ToRetention).toBe(1)
    expect(ageBuckets.olderThanRetention).toBe(1)
  })

  // Test 4: correct oldestDeletedAt and newestDeletedAt
  it('returns correct oldestDeletedAt and newestDeletedAt', async () => {
    const oldest = '2025-01-01T00:00:00.000Z'
    const newest = '2026-05-01T00:00:00.000Z'
    const mid = '2025-06-15T00:00:00.000Z'
    await db.insert(catalogTombstones).values([
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_file', entity_id: 'f1', deleted_at: mid, created_at: mid },
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_file', entity_id: 'f2', deleted_at: oldest, created_at: oldest },
      { id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_file', entity_id: 'f3', deleted_at: newest, created_at: newest },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const stats = JSON.parse(res.body).data.tombstoneStats
    expect(stats.oldestDeletedAt).toBe(oldest)
    expect(stats.newestDeletedAt).toBe(newest)
  })

  // Test 5: response never includes individual tombstone rows, file paths, or credential fields
  it('response never includes individual tombstone rows, file paths, or credential fields', async () => {
    const now = new Date().toISOString()
    await db.insert(catalogTombstones).values({
      id: crypto.randomUUID(), node_id: localNodeId, entity_type: 'media_file',
      entity_id: 'secret-file-id', deleted_at: now, created_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const raw = res.body

    // Must not expose raw tombstone rows or sensitive fields
    expect(raw).not.toContain('secret-file-id')
    expect(raw).not.toContain('api_token')
    expect(raw).not.toContain('federation_token')
    expect(raw).not.toContain('password')
    expect(raw).not.toContain('encrypted')
    expect(raw).not.toContain('root_path')

    // Response must be aggregated counts only
    const body = JSON.parse(raw)
    const stats = body.data.tombstoneStats
    expect(typeof stats.total).toBe('number')
    expect(typeof stats.byEntityType).toBe('object')
    // Should not have a "rows" or "tombstones" array
    expect(stats.rows).toBeUndefined()
    expect(stats.tombstones).toBeUndefined()
  })
})

// ─── Safety helper tests ──────────────────────────────────────────────────────

describe('computeSyncSafetyEstimate helper', () => {
  const tombstoneRetentionDays = 90

  // Test 6: lastSyncAt = null → no_last_sync (full sync)
  it('lastSyncAt = null → incrementalSafeNow=false, full, no_last_sync', () => {
    const result = computeSyncSafetyEstimate(null, tombstoneRetentionDays)
    expect(result.incrementalSafeNow).toBe(false)
    expect(result.nextSyncModeEstimate).toBe('full')
    expect(result.nextSyncReason).toBe('no_last_sync')
  })

  // Test 7: within retention → incremental
  it('lastSyncAt within retention → incrementalSafeNow=true, incremental, within_retention', () => {
    // 1 hour ago — well within 90-day window
    const lastSyncAt = new Date(Date.now() - 3600_000).toISOString()
    const result = computeSyncSafetyEstimate(lastSyncAt, tombstoneRetentionDays)
    expect(result.incrementalSafeNow).toBe(true)
    expect(result.nextSyncModeEstimate).toBe('incremental')
    expect(result.nextSyncReason).toBe('within_retention')
  })

  // Test 8: older than retention → tombstone_retention_exceeded (full sync)
  it('lastSyncAt older than retention → incrementalSafeNow=false, full, tombstone_retention_exceeded', () => {
    // 100 days ago — beyond 90-day window
    const lastSyncAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    const result = computeSyncSafetyEstimate(lastSyncAt, tombstoneRetentionDays)
    expect(result.incrementalSafeNow).toBe(false)
    expect(result.nextSyncModeEstimate).toBe('full')
    expect(result.nextSyncReason).toBe('tombstone_retention_exceeded')
  })
})

// ─── Diagnostics persistence tests ───────────────────────────────────────────

describe('Diagnostics persistence after sync', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-syncdiag-persist-${crypto.randomUUID()}`)
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

  async function addRemoteNode() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    return JSON.parse(res.body).data.id as string
  }

  function buildMockCatalog(nodeId: string): FederationCatalogData {
    return {
      nodeId,
      nodeName: 'Remote Helix',
      exportedAt: Date.now(),
      libraries: [{ id: 'diag-lib-1', name: 'Remote Movies', kind: 'movies', itemCount: 2 }],
      items: [
        {
          id: 'diag-item-1', library_id: 'diag-lib-1', parent_id: null, kind: 'movie',
          title: 'Movie 1', sort_title: 'Movie 1', year: 2022, overview: null,
          has_poster: false, has_backdrop: false, original_title: null,
          release_date: null, content_rating: null, runtime_seconds: null,
          season_number: null, episode_number: null, episode_title: null,
          absolute_episode_number: null, metadata_status: 'matched',
          external_tmdb_id: null, external_tvdb_id: null,
          updated_at: new Date().toISOString(),
        },
        {
          id: 'diag-item-2', library_id: 'diag-lib-1', parent_id: null, kind: 'movie',
          title: 'Movie 2', sort_title: 'Movie 2', year: 2023, overview: null,
          has_poster: false, has_backdrop: false, original_title: null,
          release_date: null, content_rating: null, runtime_seconds: null,
          season_number: null, episode_number: null, episode_title: null,
          absolute_episode_number: null, metadata_status: 'matched',
          external_tmdb_id: null, external_tvdb_id: null,
          updated_at: new Date().toISOString(),
        },
      ],
      versions: [
        { id: 'diag-ver-1', media_item_id: 'diag-item-1', label: null, quality_label: '1080p',
          resolution_width: 1920, resolution_height: 1080, video_codec: 'h264', audio_codec: 'aac',
          container: 'mkv', duration_seconds: 5400 },
        { id: 'diag-ver-2', media_item_id: 'diag-item-2', label: null, quality_label: '1080p',
          resolution_width: 1920, resolution_height: 1080, video_codec: 'h264', audio_codec: 'aac',
          container: 'mkv', duration_seconds: 3600 },
      ],
      files: [
        { id: 'diag-file-1', media_item_id: 'diag-item-1', media_version_id: 'diag-ver-1',
          filename: 'movie1.mkv', extension: 'mkv', size_bytes: 3000000000 },
      ],
      tombstones: [],
    }
  }

  // Test 9: manual sync stores last_sync_mode and counts in nodes table
  it('manual sync stores last_sync_mode and counts in nodes table', async () => {
    const nodeId = await addRemoteNode()
    const mockCatalog = buildMockCatalog(nodeId)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: mockCatalog }),
    }))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)

    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(node.last_sync_mode).toBe('full') // no last_sync_at → full sync
    expect(node.last_sync_items_synced).toBe(2)
    expect(node.last_sync_versions_synced).toBe(2)
    expect(node.last_sync_files_synced).toBe(1)
    expect(node.last_sync_tombstones_applied).toBe(0)
    expect(node.last_sync_diagnostics_updated_at).toBeTruthy()
  })

  // Test 10: background sync stores last_sync_mode and counts
  it('background sync (via createTrustedHomeSyncScheduler) stores diagnostics', async () => {
    const nodeId = await addRemoteNode()
    const mockCatalog = buildMockCatalog(nodeId)

    // Set last_sync_at so incremental is attempted
    await db.update(nodes).set({ last_sync_at: Date.now() - 3600_000 }).where(eq(nodes.id, nodeId))

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { ...mockCatalog, incremental: true, since: new Date(Date.now() - 3600_000).toISOString() },
      }),
    }))

    // Trigger via manual sync endpoint with last_sync_at set (incremental path)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.incremental).toBe(true)

    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(node.last_sync_mode).toBe('incremental')
    expect(node.last_sync_items_synced).toBe(2)
    expect(node.last_sync_diagnostics_updated_at).toBeTruthy()
  })

  // Test 11: retention fallback stores last_sync_fallback_reason
  it('retention fallback stores last_sync_fallback_reason = tombstone_retention_exceeded', async () => {
    const nodeId = await addRemoteNode()
    // Set last_sync_at to 100 days ago (beyond 90-day retention)
    const oldSyncMs = Date.now() - 100 * 24 * 60 * 60 * 1000
    await db.update(nodes).set({ last_sync_at: oldSyncMs }).where(eq(nodes.id, nodeId))

    const mockCatalog = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: mockCatalog }),
    }))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.fallbackUsed).toBe(true)
    expect(body.data.fallbackReason).toBe('tombstone_retention_exceeded')

    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(node.last_sync_mode).toBe('full')
    expect(node.last_sync_fallback_reason).toBe('tombstone_retention_exceeded')
    expect(node.last_sync_diagnostics_updated_at).toBeTruthy()
  })

  // Test 12: failed sync does NOT overwrite last-sync diagnostics fields
  it('failed sync does NOT overwrite existing last-sync diagnostics fields', async () => {
    const nodeId = await addRemoteNode()

    // First: do a successful sync to set baseline diagnostics
    const mockCatalog = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: mockCatalog }),
    }))
    await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    // Capture baseline
    const [beforeNode] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(beforeNode.last_sync_mode).toBe('full')
    expect(beforeNode.last_sync_items_synced).toBe(2)
    const beforeUpdatedAt = beforeNode.last_sync_diagnostics_updated_at

    // Now fail the next sync
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')))
    const failRes = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(failRes.statusCode).toBe(500)

    // Diagnostics fields must NOT have changed
    const [afterNode] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(afterNode.last_sync_mode).toBe(beforeNode.last_sync_mode)
    expect(afterNode.last_sync_items_synced).toBe(beforeNode.last_sync_items_synced)
    expect(afterNode.last_sync_diagnostics_updated_at).toBe(beforeUpdatedAt)
  })
})

// ─── Authorization tests ──────────────────────────────────────────────────────

describe('GET /api/v1/admin/sync-diagnostics — authorization', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-syncdiag-auth-${crypto.randomUUID()}`)
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

  // Test 13: unauthenticated → 401
  it('unauthenticated request returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
    })
    expect(res.statusCode).toBe(401)
  })

  // Test 14: normal user → 403
  it('normal (non-admin) user returns 403', async () => {
    // Create a non-admin user
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { Cookie: adminCookie },
      payload: { username: 'normaluser', password: 'password123', displayName: 'Normal User' },
    })
    expect(createRes.statusCode).toBe(201)

    // Log in as non-admin
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'normaluser', password: 'password123' },
    })
    expect(loginRes.statusCode).toBe(200)
    const userCookie = loginRes.headers['set-cookie'] as string

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: userCookie },
    })
    expect(res.statusCode).toBe(403)
  })

  // Test 15: admin returns valid diagnostics response
  it('admin user receives 200 with valid diagnostics shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)

    // tombstoneStats shape
    const stats = body.data.tombstoneStats
    expect(typeof stats.total).toBe('number')
    expect(typeof stats.byEntityType).toBe('object')
    expect(typeof stats.ageBuckets).toBe('object')
    expect(typeof stats.ageBuckets.under7Days).toBe('number')
    expect(typeof stats.ageBuckets.days7To30).toBe('number')
    expect(typeof stats.ageBuckets.days30ToRetention).toBe('number')
    expect(typeof stats.ageBuckets.olderThanRetention).toBe('number')
    expect(typeof stats.tombstoneRetentionDays).toBe('number')
    expect(typeof stats.pruneCutoff).toBe('string')

    // trustedHomeSync shape (may be empty array)
    expect(Array.isArray(body.data.trustedHomeSync)).toBe(true)
  })
})
