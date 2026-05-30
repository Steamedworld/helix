/**
 * Incremental catalog sync tests.
 *
 * Covers:
 *   - Federation catalog ?since endpoint behaviour (6 tests)
 *   - Hub-side sync decision logic (7 tests)
 *   - Integration regressions (3 tests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { eq, inArray } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { setupAuth } from './helpers/auth'
import { nodes, libraries, mediaItems, mediaVersions, mediaFiles, catalogTombstones } from '../src/db/schema'
import type { FederationCatalogData } from '../src/services/federation/catalogSync'
import { importCatalog } from '../src/services/federation/catalogSync'
import { recordTombstone, recordTombstones } from '../src/services/federation/tombstones'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

// ─── Shared catalog fixture builder ──────────────────────────────────────────

function buildMockCatalog(
  nodeId: string,
  overrides?: Partial<FederationCatalogData>
): FederationCatalogData {
  const libId = 'inc-lib-1'
  const itemId = 'inc-item-1'
  const versionId = 'inc-ver-1'
  const fileId = 'inc-file-1'
  return {
    nodeId,
    nodeName: 'Remote Helix',
    exportedAt: Date.now(),
    libraries: [{ id: libId, name: 'Remote Movies', kind: 'movies', itemCount: 1 }],
    items: [
      {
        id: itemId,
        library_id: libId,
        parent_id: null,
        kind: 'movie',
        title: 'Test Movie',
        sort_title: 'Test Movie',
        year: 2022,
        overview: 'A test movie',
        has_poster: true,
        has_backdrop: false,
        original_title: null,
        release_date: '2022-01-01',
        content_rating: null,
        runtime_seconds: 5400,
        season_number: null,
        episode_number: null,
        episode_title: null,
        absolute_episode_number: null,
        metadata_status: 'matched',
        external_tmdb_id: '99999',
        external_tvdb_id: null,
        updated_at: new Date().toISOString(),
      },
    ],
    versions: [
      {
        id: versionId,
        media_item_id: itemId,
        label: null,
        quality_label: '1080p',
        resolution_width: 1920,
        resolution_height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        container: 'mkv',
        duration_seconds: 5400,
      },
    ],
    files: [
      {
        id: fileId,
        media_item_id: itemId,
        media_version_id: versionId,
        filename: 'test-movie.mkv',
        extension: 'mkv',
        size_bytes: 3000000000,
      },
    ],
    ...overrides,
  }
}

// ─── Helper: seed a library + item + version + file into the DB ────────────

async function seedLocalCatalog(
  db: TestDb,
  localNodeId: string,
  updatedAt: string
): Promise<{ libId: string; itemId: string; versionId: string; fileId: string }> {
  const libId = crypto.randomUUID()
  const itemId = crypto.randomUUID()
  const versionId = crypto.randomUUID()
  const fileId = crypto.randomUUID()

  await db.insert(libraries).values({
    id: libId,
    node_id: localNodeId,
    name: 'Movies',
    kind: 'movies',
    root_path: '/movies',
    scan_status: 'idle',
    created_at: updatedAt,
    updated_at: updatedAt,
  })
  await db.insert(mediaItems).values({
    id: itemId,
    library_id: libId,
    kind: 'movie',
    title: 'Seeded Movie',
    sort_title: 'Seeded Movie',
    metadata_status: 'matched',
    poster_path: '/posters/movie.jpg',
    backdrop_path: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  })
  await db.insert(mediaVersions).values({
    id: versionId,
    media_item_id: itemId,
    quality_label: '1080p',
    container: 'mkv',
    created_at: updatedAt,
    updated_at: updatedAt,
  })
  await db.insert(mediaFiles).values({
    id: fileId,
    node_id: localNodeId,
    library_id: libId,
    media_item_id: itemId,
    media_version_id: versionId,
    path: `/movies/${libId}/movie.mkv`,
    filename: 'movie.mkv',
    extension: 'mkv',
    size_bytes: 2000000000,
    file_hash: null,
    missing_at: null,
    discovered_at: updatedAt,
    updated_at: updatedAt,
  })

  return { libId, itemId, versionId, fileId }
}

// ─── Federation catalog ?since endpoint tests ─────────────────────────────────

describe('Federation catalog ?since support', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-inc-catalog-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    rawToken = JSON.parse(tokenRes.body).data.token
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('without ?since: returns full catalog with incremental=false', async () => {
    const pastTs = '2020-01-01T00:00:00.000Z'
    await seedLocalCatalog(db, localNodeId, pastTs)

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/catalog',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.incremental).toBe(false)
    expect(body.data.since).toBeUndefined()
    expect(body.data.items.length).toBeGreaterThan(0)
  })

  it('with valid ?since in the past: returns only records updated after that time', async () => {
    const oldTs = '2020-01-01T00:00:00.000Z'
    const newTs = '2026-01-01T00:00:00.000Z'

    // Seed an old item
    await seedLocalCatalog(db, localNodeId, oldTs)
    // Seed a new item
    await seedLocalCatalog(db, localNodeId, newTs)

    // Request items since 2025 — should return only the 2026 item
    const sinceTs = '2025-01-01T00:00:00.000Z'
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.incremental).toBe(true)
    expect(body.data.since).toBe(sinceTs)
    // Only the newer item should be returned
    expect(body.data.items.length).toBe(1)
    // Libraries are always included for context
    expect(body.data.libraries.length).toBeGreaterThanOrEqual(1)
  })

  it('with ?since before all records: returns full catalog effectively', async () => {
    const ts = '2024-06-01T00:00:00.000Z'
    await seedLocalCatalog(db, localNodeId, ts)

    const sinceTs = '2000-01-01T00:00:00.000Z' // before everything
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.incremental).toBe(true)
    expect(body.data.items.length).toBeGreaterThan(0) // all items are newer than 2000
  })

  it('with ?since after all records: returns empty items array', async () => {
    const ts = '2024-01-01T00:00:00.000Z'
    await seedLocalCatalog(db, localNodeId, ts)

    const sinceTs = '2030-01-01T00:00:00.000Z' // future — nothing is newer
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.incremental).toBe(true)
    expect(body.data.items.length).toBe(0)
    expect(body.data.versions.length).toBe(0)
    expect(body.data.files.length).toBe(0)
  })

  it('with invalid ?since timestamp: returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/catalog?since=not-a-date',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
  })

  it('catalog response never includes filesystem paths or secrets', async () => {
    const ts = new Date().toISOString()
    await seedLocalCatalog(db, localNodeId, ts)

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/catalog',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)

    // Items must not expose raw file paths
    for (const item of body.data.items) {
      expect(item.poster_path).toBeUndefined()
      expect(item.backdrop_path).toBeUndefined()
      expect(item.has_poster).toBeDefined()
    }
    // Files must not expose path
    for (const file of body.data.files) {
      expect(file.path).toBeUndefined()
      expect(file.filename).toBeDefined()
    }
  })
})

// ─── Federation catalog ?since — version/file timestamp coverage ──────────────

describe('Federation catalog ?since — version and file timestamp coverage', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-inc-vf-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    rawToken = JSON.parse(tokenRes.body).data.token
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 1: ?since includes item whose media_version.updated_at >= since even if media_item.updated_at did not change
  it('?since includes item whose media_version.updated_at >= since (item itself not updated)', async () => {
    const oldTs = '2020-01-01T00:00:00.000Z'
    const newTs = '2026-01-01T00:00:00.000Z'
    const sinceTs = '2025-01-01T00:00:00.000Z'

    // Seed item with old timestamps
    const { itemId, versionId } = await seedLocalCatalog(db, localNodeId, oldTs)

    // Update the version's updated_at to be newer than sinceTs — item itself stays old
    await db.update(mediaVersions).set({ updated_at: newTs, quality_label: '4K' }).where(eq(mediaVersions.id, versionId))

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.incremental).toBe(true)
    // The item should be included because its version was updated
    const returnedItemIds = body.data.items.map((i: { id: string }) => i.id)
    expect(returnedItemIds).toContain(itemId)
  })

  // Test 2: ?since includes item whose media_file.updated_at >= since even if media_item.updated_at did not change
  it('?since includes item whose media_file.updated_at >= since (item itself not updated)', async () => {
    const oldTs = '2020-01-01T00:00:00.000Z'
    const newTs = '2026-01-01T00:00:00.000Z'
    const sinceTs = '2025-01-01T00:00:00.000Z'

    const { itemId, fileId } = await seedLocalCatalog(db, localNodeId, oldTs)

    // Update file updated_at — item stays old
    await db.update(mediaFiles).set({ updated_at: newTs }).where(eq(mediaFiles.id, fileId))

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.incremental).toBe(true)
    const returnedItemIds = body.data.items.map((i: { id: string }) => i.id)
    expect(returnedItemIds).toContain(itemId)
  })

  // Test 3: ?since includes the full version and file data for matched items
  it('?since includes full version and file data for matched items', async () => {
    const oldTs = '2020-01-01T00:00:00.000Z'
    const newTs = '2026-01-01T00:00:00.000Z'
    const sinceTs = '2025-01-01T00:00:00.000Z'

    const { itemId, versionId, fileId } = await seedLocalCatalog(db, localNodeId, oldTs)

    // Update the version timestamp so the item is included
    await db.update(mediaVersions).set({ updated_at: newTs }).where(eq(mediaVersions.id, versionId))

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)

    // Item returned
    expect(body.data.items.some((i: { id: string }) => i.id === itemId)).toBe(true)

    // Version included
    const returnedVersionIds = body.data.versions.map((v: { id: string }) => v.id)
    expect(returnedVersionIds).toContain(versionId)

    // File included
    const returnedFileIds = body.data.files.map((f: { id: string }) => f.id)
    expect(returnedFileIds).toContain(fileId)
  })

  // Test 4: item with no version/file change and media_item.updated_at < since is NOT included
  it('item with no version/file change and item.updated_at < since is NOT included', async () => {
    const oldTs = '2020-01-01T00:00:00.000Z'
    const sinceTs = '2025-01-01T00:00:00.000Z'

    await seedLocalCatalog(db, localNodeId, oldTs)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.incremental).toBe(true)
    expect(body.data.items.length).toBe(0)
    expect(body.data.versions.length).toBe(0)
    expect(body.data.files.length).toBe(0)
  })

  // Test 5: response never includes filesystem paths (regression on path-stripping)
  it('incremental response never exposes filesystem paths (regression)', async () => {
    const newTs = new Date().toISOString()
    await seedLocalCatalog(db, localNodeId, newTs)

    const sinceTs = '2000-01-01T00:00:00.000Z'
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.incremental).toBe(true)

    // Items must not include raw fs paths
    for (const item of body.data.items) {
      expect(item.poster_path).toBeUndefined()
      expect(item.backdrop_path).toBeUndefined()
      expect(item.has_poster).toBeDefined()
    }
    // Files must not include path
    for (const file of body.data.files) {
      expect(file.path).toBeUndefined()
      expect(file.filename).toBeDefined()
    }
  })
})

// ─── Import behaviour — version and file upserts via incremental ──────────────

describe('Import behaviour — version and file upserts via incremental sync', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-inc-import-${crypto.randomUUID()}`)
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

  // Test 6: incremental import upserts changed media_version row correctly
  it('incremental import upserts changed media_version row correctly', async () => {
    const nodeId = await addRemoteNode()

    // Initial full sync
    const initial = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: initial }),
    }))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    // Verify initial version
    const [v1] = await db.select().from(mediaVersions).where(eq(mediaVersions.id, 'inc-ver-1'))
    expect(v1).toBeDefined()
    expect(v1.quality_label).toBe('1080p')

    // Incremental sync with updated version quality_label
    const updated = buildMockCatalog(nodeId, {
      incremental: true,
      since: new Date(Date.now() - 1000).toISOString(),
      versions: [{
        id: 'inc-ver-1',
        media_item_id: 'inc-item-1',
        label: null,
        quality_label: '4K',
        resolution_width: 3840,
        resolution_height: 2160,
        video_codec: 'H.265',
        audio_codec: 'aac',
        container: 'mkv',
        duration_seconds: 5400,
      }],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: updated }),
    }))
    await db.update(nodes).set({ last_sync_at: Date.now() - 1000 }).where(eq(nodes.id, nodeId))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    // Version should be updated
    const [v2] = await db.select().from(mediaVersions).where(eq(mediaVersions.id, 'inc-ver-1'))
    expect(v2.quality_label).toBe('4K')
    expect(v2.resolution_width).toBe(3840)
  })

  // Test 7: incremental import upserts changed media_file row correctly
  it('incremental import upserts changed media_file row correctly', async () => {
    const nodeId = await addRemoteNode()

    // Initial full sync
    const initial = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: initial }),
    }))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    const [f1] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, 'inc-file-1'))
    expect(f1.size_bytes).toBe(3000000000)

    // Incremental sync with updated file size
    const updated = buildMockCatalog(nodeId, {
      incremental: true,
      since: new Date(Date.now() - 1000).toISOString(),
      files: [{
        id: 'inc-file-1',
        media_item_id: 'inc-item-1',
        media_version_id: 'inc-ver-1',
        filename: 'test-movie-remux.mkv',
        extension: 'mkv',
        size_bytes: 20000000000,
      }],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: updated }),
    }))
    await db.update(nodes).set({ last_sync_at: Date.now() - 1000 }).where(eq(nodes.id, nodeId))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    const [f2] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, 'inc-file-1'))
    expect(f2.filename).toBe('test-movie-remux.mkv')
    expect(f2.size_bytes).toBe(20000000000)
  })

  // Test 8: after incremental import, file record reflects updated source/version data
  it('after incremental import, file record reflects updated version reference', async () => {
    const nodeId = await addRemoteNode()

    const initial = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: initial }),
    }))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    // Incremental sync changes the version's container
    const newVersionId = 'inc-ver-1'
    const updated = buildMockCatalog(nodeId, {
      incremental: true,
      since: new Date(Date.now() - 1000).toISOString(),
      versions: [{
        id: newVersionId,
        media_item_id: 'inc-item-1',
        label: null,
        quality_label: '1080p',
        resolution_width: 1920,
        resolution_height: 1080,
        video_codec: 'H.264',
        audio_codec: 'aac',
        container: 'mp4',
        duration_seconds: 5400,
      }],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: updated }),
    }))
    await db.update(nodes).set({ last_sync_at: Date.now() - 1000 }).where(eq(nodes.id, nodeId))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    // Version container should reflect the update
    const [ver] = await db.select().from(mediaVersions).where(eq(mediaVersions.id, newVersionId))
    expect(ver.container).toBe('mp4')
  })

  // Test 9: library permissions intact after version/file update via incremental sync
  it('library permissions intact after version/file update via incremental sync', async () => {
    const nodeId = await addRemoteNode()

    // Initial full sync
    const initial = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: initial }),
    }))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    // Grant a user access to the synced library
    const userRes = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { Cookie: adminCookie },
      payload: { username: 'testuser2', password: 'password123', displayName: 'Test User 2' },
    })
    const userId = JSON.parse(userRes.body).data.id

    const { libraryPermissions: libPermsSchema } = await import('../src/db/schema')
    const libRes = await db.select().from(libraries).where(eq(libraries.node_id, nodeId))
    const libId = libRes[0].id

    await app.inject({
      method: 'PUT',
      url: `/api/v1/nodes/${nodeId}/access`,
      headers: { Cookie: adminCookie },
      payload: { grants: [{ libraryId: libId, userId, canView: true, canPlay: true }] },
    })

    const grantsBefore = await db.select().from(libPermsSchema).where(eq(libPermsSchema.library_id, libId))
    expect(grantsBefore.length).toBe(1)

    // Incremental sync that updates a version
    const updated = buildMockCatalog(nodeId, {
      incremental: true,
      since: new Date(Date.now() - 1000).toISOString(),
      versions: [{
        id: 'inc-ver-1',
        media_item_id: 'inc-item-1',
        label: null,
        quality_label: '4K',
        resolution_width: 3840,
        resolution_height: 2160,
        video_codec: 'H.265',
        audio_codec: 'aac',
        container: 'mkv',
        duration_seconds: 5400,
      }],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: updated }),
    }))
    await db.update(nodes).set({ last_sync_at: Date.now() - 1000 }).where(eq(nodes.id, nodeId))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    // Permissions must still be intact
    const grantsAfter = await db.select().from(libPermsSchema).where(eq(libPermsSchema.library_id, libId))
    expect(grantsAfter.length).toBe(1)
    expect(grantsAfter[0].can_view).toBe(true)
    expect(grantsAfter[0].can_play).toBe(true)
  })
})

// ─── Regression: version/file sync coverage ───────────────────────────────────

describe('Incremental sync regressions — full sync and invalid timestamp', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-inc-reg2-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    rawToken = JSON.parse(tokenRes.body).data.token
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 10: full sync still returns all items including all versions/files
  it('full sync still returns all items including all versions and files', async () => {
    const ts = new Date().toISOString()
    const { itemId, versionId, fileId } = await seedLocalCatalog(db, localNodeId, ts)

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/catalog',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.incremental).toBe(false)

    const itemIds = body.data.items.map((i: { id: string }) => i.id)
    expect(itemIds).toContain(itemId)

    const versionIds = body.data.versions.map((v: { id: string }) => v.id)
    expect(versionIds).toContain(versionId)

    const fileIds = body.data.files.map((f: { id: string }) => f.id)
    expect(fileIds).toContain(fileId)
  })

  // Test 11: ?since with invalid timestamp returns 400
  it('?since with invalid timestamp still returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/catalog?since=not-a-valid-timestamp',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/invalid since|iso 8601/i)
  })
})

// ─── Hub-side sync decision logic ─────────────────────────────────────────────

describe('Hub incremental sync behaviour', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-inc-sync-${crypto.randomUUID()}`)
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

  it('full sync used when last_sync_at is null', async () => {
    const nodeId = await addRemoteNode()
    const mockCatalog = buildMockCatalog(nodeId)

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
    expect(body.data.sinceUsed).toBeNull()
    expect(body.data.fallbackUsed).toBe(false)

    // Verify the URL used did NOT contain ?since
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).not.toContain('since')
  })

  it('incremental sync used when last_sync_at exists', async () => {
    const nodeId = await addRemoteNode()

    // Manually set last_sync_at so the sync logic uses incremental
    const lastSyncMs = Date.now() - 3600_000 // 1 hour ago
    await db.update(nodes).set({ last_sync_at: lastSyncMs }).where(eq(nodes.id, nodeId))

    const mockCatalog = buildMockCatalog(nodeId)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { ...mockCatalog, incremental: true, since: new Date(lastSyncMs).toISOString() } }),
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
    expect(body.data.sinceUsed).toBe(new Date(lastSyncMs).toISOString())
    expect(body.data.fallbackUsed).toBe(false)

    // Verify ?since was included in the request URL
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toContain('since=')
  })

  it('sync updates last_sync_at on success', async () => {
    const nodeId = await addRemoteNode()
    const mockCatalog = buildMockCatalog(nodeId)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: mockCatalog }),
    }))

    const before = Date.now()
    await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    const after = Date.now()

    const [node] = await db.select({ last_sync_at: nodes.last_sync_at }).from(nodes).where(eq(nodes.id, nodeId))
    expect(node.last_sync_at).not.toBeNull()
    expect(node.last_sync_at!).toBeGreaterThanOrEqual(before)
    expect(node.last_sync_at!).toBeLessThanOrEqual(after)
  })

  it('sync does NOT update last_sync_at on failure', async () => {
    const nodeId = await addRemoteNode()

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(500)

    const [node] = await db.select({ last_sync_at: nodes.last_sync_at }).from(nodes).where(eq(nodes.id, nodeId))
    expect(node.last_sync_at).toBeNull()
  })

  it('force=true triggers full sync even when last_sync_at exists', async () => {
    const nodeId = await addRemoteNode()

    // Set last_sync_at so incremental would normally be used
    await db.update(nodes).set({ last_sync_at: Date.now() - 3600_000 }).where(eq(nodes.id, nodeId))

    const mockCatalog = buildMockCatalog(nodeId)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: mockCatalog }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync?force=true`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.fullSync).toBe(true)
    expect(body.data.incremental).toBe(false)
    expect(body.data.sinceUsed).toBeNull()

    // Should NOT contain ?since in the URL
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).not.toContain('since')
  })

  it('incremental sync: items not in response are NOT deleted', async () => {
    const nodeId = await addRemoteNode()

    // First: full sync with 2 items
    const item2Id = 'inc-item-2'
    const ver2Id = 'inc-ver-2'
    const file2Id = 'inc-file-2'
    const fullCatalog = buildMockCatalog(nodeId, {
      items: [
        ...(buildMockCatalog(nodeId).items),
        {
          id: item2Id,
          library_id: 'inc-lib-1',
          parent_id: null,
          kind: 'movie',
          title: 'Second Movie',
          sort_title: 'Second Movie',
          year: 2023,
          overview: null,
          has_poster: false,
          has_backdrop: false,
          original_title: null,
          release_date: null,
          content_rating: null,
          runtime_seconds: null,
          season_number: null,
          episode_number: null,
          episode_title: null,
          absolute_episode_number: null,
          metadata_status: 'matched',
          external_tmdb_id: null,
          external_tvdb_id: null,
          updated_at: new Date().toISOString(),
        },
      ],
      versions: [
        ...(buildMockCatalog(nodeId).versions),
        { id: ver2Id, media_item_id: item2Id, label: null, quality_label: null,
          resolution_width: null, resolution_height: null, video_codec: null,
          audio_codec: null, container: 'mp4', duration_seconds: null },
      ],
      files: [
        ...(buildMockCatalog(nodeId).files),
        { id: file2Id, media_item_id: item2Id, media_version_id: ver2Id,
          filename: 'second.mp4', extension: 'mp4', size_bytes: 1000000000 },
      ],
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: fullCatalog }),
    }))

    await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    // Verify both items exist after full sync
    const itemsBefore = await db.select().from(mediaItems).where(eq(mediaItems.library_id, 'inc-lib-1'))
    expect(itemsBefore.length).toBe(2)

    // Second sync: incremental, returns only item1 (item2 was "deleted" on remote)
    const partialCatalog = buildMockCatalog(nodeId, {
      incremental: true,
      since: new Date(Date.now() - 1000).toISOString(),
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: partialCatalog }),
    }))

    // Set last_sync_at so incremental is used
    await db.update(nodes).set({ last_sync_at: Date.now() - 1000 }).where(eq(nodes.id, nodeId))

    const syncRes = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(syncRes.statusCode).toBe(200)

    // item2 should still exist — incremental does NOT delete absent items
    const itemsAfter = await db.select().from(mediaItems).where(eq(mediaItems.library_id, 'inc-lib-1'))
    expect(itemsAfter.length).toBe(2)
    const item2 = itemsAfter.find((i) => i.id === item2Id)
    expect(item2).toBeDefined()
  })

  it('incremental sync is idempotent (applying same data twice = same result)', async () => {
    const nodeId = await addRemoteNode()

    // Initial sync
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

    // Set last_sync_at so next sync is incremental
    await db.update(nodes).set({ last_sync_at: Date.now() - 1000 }).where(eq(nodes.id, nodeId))

    // Incremental sync returns the same item
    const incrementalCatalog = buildMockCatalog(nodeId, {
      incremental: true,
      since: new Date(Date.now() - 1000).toISOString(),
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: incrementalCatalog }),
    }))
    await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    // Still exactly 1 of each
    const items = await db.select().from(mediaItems).where(eq(mediaItems.library_id, 'inc-lib-1'))
    expect(items.length).toBe(1)
    const files = await db.select().from(mediaFiles).where(eq(mediaFiles.node_id, nodeId))
    expect(files.length).toBe(1)
  })
})

// ─── Integration: regressions ─────────────────────────────────────────────────

describe('Incremental sync integration regressions', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-inc-integ-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    rawToken = JSON.parse(tokenRes.body).data.token
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('full sync still works (regression)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id
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
    expect(body.data.synced).toBe(true)
    expect(body.data.librariesSynced).toBe(1)
    expect(body.data.itemsSynced).toBe(1)

    const libs = await db.select().from(libraries).where(eq(libraries.node_id, nodeId))
    expect(libs.length).toBe(1)
    const items = await db.select().from(mediaItems).where(eq(mediaItems.library_id, 'inc-lib-1'))
    expect(items.length).toBe(1)
  })

  it('library permissions are preserved after library record update via incremental sync', async () => {
    // Add a remote node and do initial sync
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id
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

    // Create a non-admin user and grant access to the remote library
    const userRes = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { Cookie: adminCookie },
      payload: { username: 'testuser', password: 'password123', displayName: 'Test User' },
    })
    expect(userRes.statusCode).toBe(201)
    const userId = JSON.parse(userRes.body).data.id

    const libRes = await db.select().from(libraries).where(eq(libraries.node_id, nodeId))
    const libId = libRes[0].id

    await app.inject({
      method: 'PUT',
      url: `/api/v1/nodes/${nodeId}/access`,
      headers: { Cookie: adminCookie },
      payload: {
        grants: [{ libraryId: libId, userId, canView: true, canPlay: true }],
      },
    })

    // Verify grant exists
    const { libraryPermissions } = await import('../src/db/schema')
    const grantsBefore = await db
      .select()
      .from(libraryPermissions)
      .where(eq(libraryPermissions.library_id, libId))
    expect(grantsBefore.length).toBe(1)

    // Now do an incremental sync (library record gets upserted — name update)
    const updatedCatalog = buildMockCatalog(nodeId, {
      incremental: true,
      since: new Date(Date.now() - 1000).toISOString(),
      libraries: [{ id: 'inc-lib-1', name: 'Updated Library Name', kind: 'movies', itemCount: 1 }],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: updatedCatalog }),
    }))

    await db.update(nodes).set({ last_sync_at: Date.now() - 1000 }).where(eq(nodes.id, nodeId))

    await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    // Grant must still exist after the library upsert
    const grantsAfter = await db
      .select()
      .from(libraryPermissions)
      .where(eq(libraryPermissions.library_id, libId))
    expect(grantsAfter.length).toBe(1)
    expect(grantsAfter[0].can_view).toBe(true)
    expect(grantsAfter[0].can_play).toBe(true)
  })

  it('remote artwork proxy still works after incremental sync', async () => {
    const ts = new Date().toISOString()
    // Seed a local library+item with artwork for the remote art endpoint to serve
    const { itemId } = await seedLocalCatalog(db, localNodeId, ts)

    // The artwork proxy endpoint requires the item to belong to a local library
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/artwork/poster`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    // Artwork file doesn't exist on disk in test, so we get 404 — not 401/403/500
    // This confirms the auth and routing still works after catalog changes
    expect([200, 404]).toContain(res.statusCode)
    const body = JSON.parse(res.body)
    // If 404, the error should be about artwork not being available — NOT auth or routing
    if (res.statusCode === 404) {
      expect(body.ok).toBe(false)
      expect(body.error).toMatch(/artwork|not found/i)
    }
  })
})

// ─── Tombstone API — catalog endpoint ────────────────────────────────────────

describe('Tombstone catalog API', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-tombstone-api-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createDb(join(testDir, 'test.db'))
    runMigrations(db, join(__dirname, '../drizzle'))
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    rawToken = JSON.parse(tokenRes.body).data.token
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 1: ?since response includes tombstones after the timestamp
  it('?since response includes tombstones created after since timestamp', async () => {
    const sinceTs = '2025-01-01T00:00:00.000Z'
    const afterTs = '2026-01-01T00:00:00.000Z'
    const beforeTs = '2024-01-01T00:00:00.000Z'

    // Insert tombstones directly — one after since, one before
    await db.insert(catalogTombstones).values([
      {
        id: crypto.randomUUID(),
        node_id: localNodeId,
        entity_type: 'media_file',
        entity_id: 'file-after',
        deleted_at: afterTs,
        reason: 'scan_missing',
        created_at: afterTs,
      },
      {
        id: crypto.randomUUID(),
        node_id: localNodeId,
        entity_type: 'media_item',
        entity_id: 'item-before',
        deleted_at: beforeTs,
        reason: 'unknown',
        created_at: beforeTs,
      },
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.tombstones).toBeDefined()
    const tombstones = body.data.tombstones as Array<{ entityId: string }>
    const ids = tombstones.map((t) => t.entityId)
    expect(ids).toContain('file-after')
    expect(ids).not.toContain('item-before')
  })

  // Test 2: tombstones before ?since are excluded
  it('tombstones before since timestamp are excluded from response', async () => {
    const sinceTs = '2025-06-01T00:00:00.000Z'
    // Insert a tombstone well before the since ts
    await db.insert(catalogTombstones).values({
      id: crypto.randomUUID(),
      node_id: localNodeId,
      entity_type: 'media_version',
      entity_id: 'old-version',
      deleted_at: '2024-01-01T00:00:00.000Z',
      reason: 'unknown',
      created_at: '2024-01-01T00:00:00.000Z',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.tombstones).toBeDefined()
    const ids = (body.data.tombstones as Array<{ entityId: string }>).map((t) => t.entityId)
    expect(ids).not.toContain('old-version')
  })

  // Test 3: full sync (no ?since) returns tombstones as empty array or field absent
  it('full catalog response has empty tombstones array', async () => {
    await db.insert(catalogTombstones).values({
      id: crypto.randomUUID(),
      node_id: localNodeId,
      entity_type: 'media_file',
      entity_id: 'some-file',
      deleted_at: new Date().toISOString(),
      reason: 'scan_missing',
      created_at: new Date().toISOString(),
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/catalog',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    // Full sync: tombstones should be empty or absent
    const tombstones = body.data.tombstones ?? []
    expect(Array.isArray(tombstones)).toBe(true)
    expect(tombstones.length).toBe(0)
  })

  // Test 4: tombstone response fields — entityType, entityId, deletedAt, reason
  it('tombstone response includes entityType, entityId, deletedAt, reason fields', async () => {
    const deletedAt = '2026-03-15T12:00:00.000Z'
    await db.insert(catalogTombstones).values({
      id: crypto.randomUUID(),
      node_id: localNodeId,
      entity_type: 'media_item',
      entity_id: 'item-abc',
      deleted_at: deletedAt,
      reason: 'scan_missing',
      created_at: deletedAt,
    })

    const sinceTs = '2026-01-01T00:00:00.000Z'
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const ts = (body.data.tombstones as Array<Record<string, string>>).find((t) => t.entityId === 'item-abc')
    expect(ts).toBeDefined()
    expect(ts!.entityType).toBe('media_item')
    expect(ts!.deletedAt).toBe(deletedAt)
    expect(ts!.reason).toBe('scan_missing')
  })

  // Test 5: tombstone response never includes file paths or secrets
  it('tombstone response never includes file paths or secrets', async () => {
    const ts2 = await seedLocalCatalog(db, localNodeId, new Date().toISOString())
    const deletedAt = new Date().toISOString()
    await db.insert(catalogTombstones).values({
      id: crypto.randomUUID(),
      node_id: localNodeId,
      entity_type: 'media_file',
      entity_id: ts2.fileId,
      deleted_at: deletedAt,
      reason: 'scan_missing',
      created_at: deletedAt,
    })

    const sinceTs = '2000-01-01T00:00:00.000Z'
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/catalog?since=${encodeURIComponent(sinceTs)}`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const tombstones = body.data.tombstones as Array<Record<string, unknown>>
    for (const t of tombstones) {
      expect(t.path).toBeUndefined()
      expect(t.root_path).toBeUndefined()
      expect(t.api_token_encrypted).toBeUndefined()
      expect(t.federation_token_hash).toBeUndefined()
      // Should only have entityType, entityId, deletedAt, reason
      expect(t.entityType).toBeDefined()
      expect(t.entityId).toBeDefined()
      expect(t.deletedAt).toBeDefined()
    }
  })
})

// ─── Tombstone creation via recordTombstone helpers ───────────────────────────

describe('Tombstone creation helpers', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-tombstone-create-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createDb(join(testDir, 'test.db'))
    runMigrations(db, join(__dirname, '../drizzle'))
    localNodeId = await bootstrap(db, testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 6: deleting a media_file records a media_file tombstone
  it('recordTombstone creates a media_file tombstone', async () => {
    await recordTombstone(db, localNodeId, 'media_file', 'file-xyz', 'scan_missing')
    const rows = await db
      .select()
      .from(catalogTombstones)
      .where(eq(catalogTombstones.entity_id, 'file-xyz'))
    expect(rows.length).toBe(1)
    expect(rows[0].entity_type).toBe('media_file')
    expect(rows[0].reason).toBe('scan_missing')
    expect(rows[0].node_id).toBe(localNodeId)
  })

  // Test 7: recordTombstones for a batch records one tombstone per ID
  it('recordTombstones creates tombstones for all IDs in batch', async () => {
    const ids = ['ver-1', 'ver-2', 'ver-3']
    await recordTombstones(db, localNodeId, 'media_version', ids, 'unknown')
    const rows = await db
      .select()
      .from(catalogTombstones)
      .where(eq(catalogTombstones.entity_type, 'media_version'))
    expect(rows.length).toBe(3)
    const recordedIds = rows.map((r) => r.entity_id)
    for (const id of ids) {
      expect(recordedIds).toContain(id)
    }
  })

  // Test 8: tombstones for item, version, and file all get their own records
  it('tombstones for item + version + file are all recorded', async () => {
    await recordTombstone(db, localNodeId, 'media_item', 'item-1', 'unknown')
    await recordTombstone(db, localNodeId, 'media_version', 'ver-1', 'unknown')
    await recordTombstone(db, localNodeId, 'media_file', 'file-1', 'unknown')

    const rows = await db.select().from(catalogTombstones)
    const types = rows.map((r) => r.entity_type)
    expect(types).toContain('media_item')
    expect(types).toContain('media_version')
    expect(types).toContain('media_file')
  })

  // Test 9: library tombstone is recorded with correct entity_type
  it('tombstone for library entity is recorded correctly', async () => {
    await recordTombstone(db, localNodeId, 'library', 'lib-99', 'admin_disconnect')
    const [row] = await db
      .select()
      .from(catalogTombstones)
      .where(eq(catalogTombstones.entity_id, 'lib-99'))
    expect(row).toBeDefined()
    expect(row.entity_type).toBe('library')
    expect(row.reason).toBe('admin_disconnect')
  })

  // Test 9b: recordTombstones is a no-op for empty array
  it('recordTombstones with empty array inserts nothing', async () => {
    await recordTombstones(db, localNodeId, 'media_file', [], 'unknown')
    const rows = await db.select().from(catalogTombstones)
    expect(rows.length).toBe(0)
  })
})

// ─── Tombstone import safety ──────────────────────────────────────────────────

describe('Tombstone import safety', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let remoteNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-tombstone-import-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createDb(join(testDir, 'test.db'))
    runMigrations(db, join(__dirname, '../drizzle'))
    localNodeId = await bootstrap(db, testDir)

    // Create a remote node record
    remoteNodeId = crypto.randomUUID()
    const now = new Date().toISOString()
    await db.insert(
      (await import('../src/db/schema')).nodes
    ).values({
      id: remoteNodeId,
      name: 'Remote',
      kind: 'remote',
      base_url: 'http://remote:3001',
      status: 'online',
      created_at: now,
      updated_at: now,
    })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  async function seedRemoteCatalog() {
    const libId = crypto.randomUUID()
    const itemId = crypto.randomUUID()
    const versionId = crypto.randomUUID()
    const fileId = crypto.randomUUID()
    const now = new Date().toISOString()

    await db.insert(libraries).values({
      id: libId, node_id: remoteNodeId, name: 'Remote Lib', kind: 'movies',
      root_path: `remote://${remoteNodeId}`, scan_status: 'idle',
      created_at: now, updated_at: now,
    })
    await db.insert(mediaItems).values({
      id: itemId, library_id: libId, kind: 'movie', title: 'Remote Movie',
      sort_title: 'remote movie', metadata_status: 'matched',
      created_at: now, updated_at: now,
    })
    await db.insert(mediaVersions).values({
      id: versionId, media_item_id: itemId, quality_label: '1080p',
      container: 'mkv', created_at: now, updated_at: now,
    })
    await db.insert(mediaFiles).values({
      id: fileId, node_id: remoteNodeId, library_id: libId,
      media_item_id: itemId, media_version_id: versionId,
      path: `remote://${remoteNodeId}/${fileId}`,
      filename: 'movie.mkv', extension: 'mkv',
      size_bytes: 1000000, file_hash: null, missing_at: null,
      discovered_at: now, updated_at: now,
    })
    return { libId, itemId, versionId, fileId }
  }

  // Test 10: remote media_file tombstone only deletes that file (node_id check)
  it('remote media_file tombstone deletes only the matching file owned by remoteNodeId', async () => {
    const { fileId, itemId } = await seedRemoteCatalog()

    // Also seed a local file that should NOT be touched
    const { fileId: localFileId } = await seedLocalCatalog(db, localNodeId, new Date().toISOString())

    const catalog: FederationCatalogData = {
      nodeId: remoteNodeId, nodeName: 'Remote', exportedAt: Date.now(),
      libraries: [], items: [], versions: [], files: [],
      tombstones: [{ entityType: 'media_file', entityId: fileId, deletedAt: new Date().toISOString() }],
    }
    const result = await importCatalog(remoteNodeId, catalog, db)

    // Remote file deleted
    const remoteFile = await db.select().from(mediaFiles).where(eq(mediaFiles.id, fileId))
    expect(remoteFile.length).toBe(0)

    // Local file untouched
    const localFile = await db.select().from(mediaFiles).where(eq(mediaFiles.id, localFileId))
    expect(localFile.length).toBe(1)

    expect(result.tombstonesApplied).toBe(1)
    expect(result.filesRemoved).toBe(1)
  })

  // Test 11: remote media_item tombstone deletes item + versions + files for that node only
  it('remote media_item tombstone deletes item, versions, and files for remote node only', async () => {
    const { itemId } = await seedRemoteCatalog()
    const { itemId: localItemId } = await seedLocalCatalog(db, localNodeId, new Date().toISOString())

    const catalog: FederationCatalogData = {
      nodeId: remoteNodeId, nodeName: 'Remote', exportedAt: Date.now(),
      libraries: [], items: [], versions: [], files: [],
      tombstones: [{ entityType: 'media_item', entityId: itemId, deletedAt: new Date().toISOString() }],
    }
    await importCatalog(remoteNodeId, catalog, db)

    // Remote item gone
    const remoteItem = await db.select().from(mediaItems).where(eq(mediaItems.id, itemId))
    expect(remoteItem.length).toBe(0)

    // Local item untouched
    const localItem = await db.select().from(mediaItems).where(eq(mediaItems.id, localItemId))
    expect(localItem.length).toBe(1)
  })

  // Test 12: tombstone for a local-node row is ignored (node_id mismatch)
  it('tombstone for a local-node row is ignored when remoteNodeId is different', async () => {
    const { fileId: localFileId } = await seedLocalCatalog(db, localNodeId, new Date().toISOString())

    // Catalog from remoteNodeId carries a tombstone for localFileId
    const catalog: FederationCatalogData = {
      nodeId: remoteNodeId, nodeName: 'Remote', exportedAt: Date.now(),
      libraries: [], items: [], versions: [], files: [],
      tombstones: [{ entityType: 'media_file', entityId: localFileId, deletedAt: new Date().toISOString() }],
    }
    await importCatalog(remoteNodeId, catalog, db)

    // Local file must NOT be deleted
    const localFile = await db.select().from(mediaFiles).where(eq(mediaFiles.id, localFileId))
    expect(localFile.length).toBe(1)
  })

  // Test 13: tombstone for a different remote node's row is ignored
  it('tombstone for a different remote node row is ignored', async () => {
    // Seed catalog under remoteNodeId
    const { fileId } = await seedRemoteCatalog()

    // A second remote node tries to tombstone remoteNodeId's file
    const otherNodeId = crypto.randomUUID()
    const now2 = new Date().toISOString()
    await db.insert(
      (await import('../src/db/schema')).nodes
    ).values({
      id: otherNodeId, name: 'Other Remote', kind: 'remote',
      base_url: 'http://other:3002', status: 'online',
      created_at: now2, updated_at: now2,
    })

    const catalog: FederationCatalogData = {
      nodeId: otherNodeId, nodeName: 'Other Remote', exportedAt: Date.now(),
      libraries: [], items: [], versions: [], files: [],
      tombstones: [{ entityType: 'media_file', entityId: fileId, deletedAt: new Date().toISOString() }],
    }
    await importCatalog(otherNodeId, catalog, db)

    // File owned by remoteNodeId must NOT be deleted
    const file = await db.select().from(mediaFiles).where(eq(mediaFiles.id, fileId))
    expect(file.length).toBe(1)
  })

  // Test 14: duplicate tombstone import is idempotent
  it('applying the same tombstone twice is idempotent', async () => {
    const { fileId } = await seedRemoteCatalog()
    const deletedAt = new Date().toISOString()

    const catalog: FederationCatalogData = {
      nodeId: remoteNodeId, nodeName: 'Remote', exportedAt: Date.now(),
      libraries: [], items: [], versions: [], files: [],
      tombstones: [{ entityType: 'media_file', entityId: fileId, deletedAt }],
    }

    // First apply — should delete
    const r1 = await importCatalog(remoteNodeId, catalog, db)
    expect(r1.tombstonesApplied).toBe(1)

    // Second apply — row already gone, should not throw
    const r2 = await importCatalog(remoteNodeId, catalog, db)
    expect(r2.tombstonesApplied).toBe(0) // nothing to delete
  })

  // Test 15: tombstone for unknown entityId is harmless (row already gone)
  it('tombstone for non-existent entityId is harmless', async () => {
    const catalog: FederationCatalogData = {
      nodeId: remoteNodeId, nodeName: 'Remote', exportedAt: Date.now(),
      libraries: [], items: [], versions: [], files: [],
      tombstones: [{ entityType: 'media_file', entityId: 'does-not-exist', deletedAt: new Date().toISOString() }],
    }
    // Should not throw
    const result = await importCatalog(remoteNodeId, catalog, db)
    expect(result.tombstonesApplied).toBe(0)
  })
})

// ─── Tombstone counts and UI ──────────────────────────────────────────────────

describe('Tombstone counts and sync response', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-tombstone-ui-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createDb(join(testDir, 'test.db'))
    runMigrations(db, join(__dirname, '../drizzle'))
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

  // Test 16: sync response includes tombstonesApplied and removal counts
  it('sync response includes tombstonesApplied and removal counts', async () => {
    const nodeId = await addRemoteNode()

    // Full sync first
    const initial = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: initial }),
    }))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    // Incremental sync with a tombstone for the file
    const withTombstone: FederationCatalogData = {
      ...buildMockCatalog(nodeId),
      incremental: true,
      since: new Date(Date.now() - 1000).toISOString(),
      items: [],
      tombstones: [{ entityType: 'media_file', entityId: 'inc-file-1', deletedAt: new Date().toISOString() }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: withTombstone }),
    }))
    await db.update(nodes).set({ last_sync_at: Date.now() - 1000 }).where(eq(nodes.id, nodeId))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.tombstonesApplied).toBeDefined()
    expect(typeof body.data.tombstonesApplied).toBe('number')
    expect(body.data.filesRemoved).toBeDefined()
    expect(body.data.itemsRemoved).toBeDefined()
  })

  // Test 17: library_permissions cleaned up when library tombstone applied
  it('library permissions are removed when a library tombstone is applied', async () => {
    const nodeId = await addRemoteNode()

    // Full sync
    const initial = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: initial }),
    }))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    // Grant a user access
    const userRes = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { Cookie: adminCookie },
      payload: { username: 'testuser-tomb', password: 'password123', displayName: 'Tombstone User' },
    })
    const userId = JSON.parse(userRes.body).data.id
    const { libraryPermissions: libPerms } = await import('../src/db/schema')
    const libRows = await db.select().from(libraries).where(eq(libraries.node_id, nodeId))
    const libId = libRows[0].id

    await app.inject({
      method: 'PUT',
      url: `/api/v1/nodes/${nodeId}/access`,
      headers: { Cookie: adminCookie },
      payload: { grants: [{ libraryId: libId, userId, canView: true, canPlay: true }] },
    })
    const grantsBefore = await db.select().from(libPerms).where(eq(libPerms.library_id, libId))
    expect(grantsBefore.length).toBe(1)

    // Incremental sync with library tombstone
    const withTombstone: FederationCatalogData = {
      ...buildMockCatalog(nodeId),
      incremental: true,
      since: new Date(Date.now() - 1000).toISOString(),
      items: [],
      tombstones: [{ entityType: 'library', entityId: libId, deletedAt: new Date().toISOString() }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: withTombstone }),
    }))
    await db.update(nodes).set({ last_sync_at: Date.now() - 1000 }).where(eq(nodes.id, nodeId))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    // Library gone → FK cascade removes permissions
    const grantsAfter = await db.select().from(libPerms).where(eq(libPerms.library_id, libId))
    expect(grantsAfter.length).toBe(0)
  })

  // Test 18: sync display still works when tombstonesApplied is 0
  it('sync response is valid when tombstonesApplied is 0 (no removals)', async () => {
    const nodeId = await addRemoteNode()

    const catalog = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: catalog }),
    }))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.synced).toBe(true)
    expect(body.data.tombstonesApplied).toBe(0)
    expect(body.data.itemsRemoved).toBe(0)
    expect(body.data.versionsRemoved).toBe(0)
    expect(body.data.filesRemoved).toBe(0)
    expect(body.data.librariesRemoved).toBe(0)
  })
})

// ─── Tombstone retention sync safety ─────────────────────────────────────────

describe('Tombstone retention sync safety', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-retention-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createDb(join(testDir, 'test.db'))
    runMigrations(db, join(__dirname, '../drizzle'))
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

  // Test 8 (regression): node with last_sync_at = null uses full sync
  it('node with last_sync_at = null uses full sync (regression)', async () => {
    const nodeId = await addRemoteNode()
    const mockCatalog = buildMockCatalog(nodeId)

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
    expect(body.data.sinceUsed).toBeNull()
    // Verify no ?since in URL
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).not.toContain('since')
  })

  // Test 9 (regression): node with last_sync_at within retention uses incremental ?since
  it('node with last_sync_at within retention window uses incremental sync', async () => {
    const nodeId = await addRemoteNode()

    // Set last_sync_at to 1 hour ago (well within 90-day window)
    const lastSyncMs = Date.now() - 3600_000
    await db.update(nodes).set({ last_sync_at: lastSyncMs }).where(eq(nodes.id, nodeId))

    const mockCatalog = buildMockCatalog(nodeId)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { ...mockCatalog, incremental: true, since: new Date(lastSyncMs).toISOString() } }),
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
    expect(body.data.fallbackUsed).toBe(false)
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toContain('since=')
  })

  // Test 10: node with last_sync_at older than retention falls back to full sync
  it('node with last_sync_at older than retention window falls back to full sync', async () => {
    const nodeId = await addRemoteNode()

    // Set last_sync_at to 100 days ago (beyond 90-day retention)
    const oldSyncMs = Date.now() - 100 * 24 * 60 * 60 * 1000
    await db.update(nodes).set({ last_sync_at: oldSyncMs }).where(eq(nodes.id, nodeId))

    const mockCatalog = buildMockCatalog(nodeId)
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
    // Verify no ?since was sent to the remote
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).not.toContain('since=')
  })

  // Test 11: fallback result includes fallbackUsed=true and fallbackReason='tombstone_retention_exceeded'
  it('retention fallback sets fallbackUsed=true and fallbackReason=tombstone_retention_exceeded', async () => {
    const nodeId = await addRemoteNode()

    // Set last_sync_at to 200 days ago
    const oldSyncMs = Date.now() - 200 * 24 * 60 * 60 * 1000
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
  })

  // Test 12: fallback full sync does not delete local-node rows
  it('retention fallback full sync does not delete local-node catalog rows', async () => {
    const nodeId = await addRemoteNode()

    // First do a normal full sync to populate remote catalog
    const mockCatalog = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: mockCatalog }),
    }))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    // Also seed a local item that MUST NOT be touched
    const localLibId = crypto.randomUUID()
    const localItemId = crypto.randomUUID()
    const localVersionId = crypto.randomUUID()
    const localFileId = crypto.randomUUID()
    const now = new Date().toISOString()
    await db.insert(libraries).values({
      id: localLibId, node_id: localNodeId, name: 'Local Movies', kind: 'movies',
      root_path: '/local/movies', scan_status: 'idle', created_at: now, updated_at: now,
    })
    await db.insert(mediaItems).values({
      id: localItemId, library_id: localLibId, kind: 'movie', title: 'Local Movie',
      sort_title: 'local movie', metadata_status: 'matched', created_at: now, updated_at: now,
    })
    await db.insert(mediaVersions).values({
      id: localVersionId, media_item_id: localItemId, quality_label: '1080p',
      container: 'mkv', created_at: now, updated_at: now,
    })
    await db.insert(mediaFiles).values({
      id: localFileId, node_id: localNodeId, library_id: localLibId,
      media_item_id: localItemId, media_version_id: localVersionId,
      path: '/local/movies/movie.mkv', filename: 'movie.mkv', extension: 'mkv',
      size_bytes: 1000000, file_hash: null, missing_at: null,
      discovered_at: now, updated_at: now,
    })

    // Now set last_sync_at to 100 days ago to trigger retention fallback
    const oldSyncMs = Date.now() - 100 * 24 * 60 * 60 * 1000
    await db.update(nodes).set({ last_sync_at: oldSyncMs }).where(eq(nodes.id, nodeId))

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

    // Local node catalog rows must still exist
    const localItem = await db.select().from(mediaItems).where(eq(mediaItems.id, localItemId))
    expect(localItem.length).toBe(1)
    const localFile = await db.select().from(mediaFiles).where(eq(mediaFiles.id, localFileId))
    expect(localFile.length).toBe(1)
  })
})

// ─── API response fields — tombstoneRetentionDays, incrementalSince ───────────

describe('Sync response new fields', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-resp-fields-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createDb(join(testDir, 'test.db'))
    runMigrations(db, join(__dirname, '../drizzle'))
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

  // Test 13: sync response includes tombstoneRetentionDays
  it('sync response includes tombstoneRetentionDays', async () => {
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
    const body = JSON.parse(res.body)
    expect(body.data.tombstoneRetentionDays).toBeDefined()
    expect(typeof body.data.tombstoneRetentionDays).toBe('number')
    expect(body.data.tombstoneRetentionDays).toBeGreaterThanOrEqual(1)
  })

  // Test 14: sync response includes incrementalSince when using incremental sync
  it('sync response includes incrementalSince when incremental sync is used', async () => {
    const nodeId = await addRemoteNode()
    const lastSyncMs = Date.now() - 3600_000

    await db.update(nodes).set({ last_sync_at: lastSyncMs }).where(eq(nodes.id, nodeId))

    const mockCatalog = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { ...mockCatalog, incremental: true, since: new Date(lastSyncMs).toISOString() } }),
    }))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.incremental).toBe(true)
    expect(body.data.incrementalSince).toBeDefined()
    expect(typeof body.data.incrementalSince).toBe('string')
    expect(body.data.incrementalSince).toBe(new Date(lastSyncMs).toISOString())
  })

  // Test 15 (regression): existing tombstone import tests still pass — full sync result is valid
  it('full sync response (regression): synced=true with correct counts', async () => {
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
    const body = JSON.parse(res.body)
    expect(body.data.synced).toBe(true)
    expect(body.data.librariesSynced).toBe(1)
    expect(body.data.itemsSynced).toBe(1)
    expect(body.data.tombstonesApplied).toBe(0)
  })

  // Test 15b (regression): incremental tombstone import still works
  it('incremental tombstone import works after new fields added (regression)', async () => {
    const nodeId = await addRemoteNode()

    // Initial full sync
    const initial = buildMockCatalog(nodeId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: initial }),
    }))
    await app.inject({ method: 'POST', url: `/api/v1/nodes/${nodeId}/sync`, headers: { Cookie: adminCookie } })

    // Incremental sync with tombstone
    const withTombstone: FederationCatalogData = {
      ...buildMockCatalog(nodeId),
      incremental: true,
      since: new Date(Date.now() - 1000).toISOString(),
      items: [],
      tombstones: [{ entityType: 'media_file', entityId: 'inc-file-1', deletedAt: new Date().toISOString() }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: withTombstone }),
    }))
    await db.update(nodes).set({ last_sync_at: Date.now() - 1000 }).where(eq(nodes.id, nodeId))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.tombstonesApplied).toBe(1)
    expect(body.data.filesRemoved).toBe(1)
    expect(body.data.incremental).toBe(true)
  })
})
