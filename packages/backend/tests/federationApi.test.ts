/**
 * Federation API tests — token management, catalog export, node management.
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
import { nodes, libraries, mediaItems, mediaVersions, mediaFiles } from '../src/db/schema'
import type { FederationCatalogData } from '../src/services/federation/catalogSync'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

// ─── Token management ─────────────────────────────────────────────────────────

describe('Federation token management', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-fed-token-${crypto.randomUUID()}`)
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

  it('GET /federation/token — no token initially', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.hasToken).toBe(false)
  })

  it('POST /federation/token — generates a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(typeof body.data.token).toBe('string')
    expect(body.data.token.length).toBeGreaterThan(0)
  })

  it('POST /federation/token then GET — shows hasToken true', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.data.hasToken).toBe(true)
  })

  it('DELETE /federation/token — revokes token', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    expect(delRes.statusCode).toBe(200)
    const delBody = JSON.parse(delRes.body)
    expect(delBody.data.revoked).toBe(true)

    // Token should no longer exist
    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    const statusBody = JSON.parse(statusRes.body)
    expect(statusBody.data.hasToken).toBe(false)
  })

  it('non-admin cannot manage federation token → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/token',
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── Federation API (health + catalog) ───────────────────────────────────────

describe('Federation API (health/catalog)', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-fed-api-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    // Generate a federation token for this test suite
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

  it('GET /federation/health — invalid token returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/health',
      headers: { Authorization: 'Bearer invalidtoken' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('GET /federation/health — no auth returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/health',
    })
    expect(res.statusCode).toBe(401)
  })

  it('GET /federation/health — valid token returns 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/health',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('online')
    expect(typeof body.data.nodeId).toBe('string')
  })

  it('GET /federation/health — session cookie is NOT accepted', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/health',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(401)
  })

  it('GET /federation/catalog — valid token returns catalog', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/catalog',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data.libraries)).toBe(true)
    expect(Array.isArray(body.data.items)).toBe(true)
    expect(Array.isArray(body.data.versions)).toBe(true)
    expect(Array.isArray(body.data.files)).toBe(true)
    expect(typeof body.data.exportedAt).toBe('number')
    expect(body.data.nodeId).toBe(localNodeId)
  })

  it('GET /federation/catalog — does NOT include poster_path or backdrop_path', async () => {
    // Insert a library + media item with artwork
    const now = new Date().toISOString()
    const libId = crypto.randomUUID()
    const itemId = crypto.randomUUID()

    await db.insert(libraries).values({
      id: libId,
      node_id: localNodeId,
      name: 'Movies',
      kind: 'movies',
      root_path: '/movies',
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })
    await db.insert(mediaItems).values({
      id: itemId,
      library_id: libId,
      parent_id: null,
      kind: 'movie',
      title: 'Test Movie',
      sort_title: 'Test Movie',
      metadata_status: 'matched',
      metadata_source: 'tmdb',
      metadata_updated_at: Date.now(),
      poster_path: '/posters/test.jpg',
      backdrop_path: '/backdrops/test.jpg',
      created_at: now,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/catalog',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    const item = body.data.items.find((i: { id: string }) => i.id === itemId)
    expect(item).toBeDefined()
    // No raw paths — only has_poster boolean
    expect(item.poster_path).toBeUndefined()
    expect(item.backdrop_path).toBeUndefined()
    expect(item.has_poster).toBe(true)
    expect(item.has_backdrop).toBe(true)
  })

  it('GET /federation/catalog — invalid token returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/catalog',
      headers: { Authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── Node management (admin only) ────────────────────────────────────────────

describe('Node management', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-node-mgmt-${crypto.randomUUID()}`)
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

  it('unauthenticated user cannot list nodes → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nodes' })
    expect(res.statusCode).toBe(401)
  })

  it('admin: list nodes — includes local node', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    const local = body.data.find((n: { kind: string }) => n.kind === 'local')
    expect(local).toBeDefined()
    // Should not expose sensitive fields
    expect(local.api_token_encrypted).toBeUndefined()
    expect(local.federation_token_hash).toBeUndefined()
  })

  it('admin: create remote node → 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: {
        name: 'Remote Helix',
        base_url: 'http://remote.helix.local:3001',
        api_token: 'abc123remotetoken',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.name).toBe('Remote Helix')
    expect(body.data.kind).toBe('remote')
    expect(body.data.status).toBe('unknown')
    // Should not expose token
    expect(body.data.api_token_encrypted).toBeUndefined()
    expect(body.data.api_token).toBeUndefined()
  })

  it('admin: create remote node — missing fields → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Bad Node' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('admin: create remote node — invalid URL → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Bad', base_url: 'not-a-url', api_token: 'token' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('admin: get node by id', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.id).toBe(nodeId)
  })

  it('admin: get non-existent node → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nodes/no-such-id',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('admin: update remote node name', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Old Name', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/nodes/${nodeId}`,
      headers: { Cookie: adminCookie },
      payload: { name: 'New Name' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.name).toBe('New Name')
  })

  it('admin: cannot modify local node via PATCH → 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/nodes/${localNodeId}`,
      headers: { Cookie: adminCookie },
      payload: { name: 'Hacked' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('admin: delete remote node', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'ToDelete', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${nodeId}`,
      headers: { Cookie: adminCookie },
    })
    expect(delRes.statusCode).toBe(200)
    const delBody = JSON.parse(delRes.body)
    expect(delBody.data.nodeRemoved).toBe(true)

    // Node should be gone
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}`,
      headers: { Cookie: adminCookie },
    })
    expect(getRes.statusCode).toBe(404)
  })

  it('admin: cannot delete local node → 400', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${localNodeId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(400)
  })

  it('admin: test connection — success path', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    // Mock fetch to simulate successful health check
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { status: 'online' } }),
    }))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/test`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.online).toBe(true)

    // Status should be updated in DB
    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(node.status).toBe('online')
    expect(node.last_seen_at).not.toBeNull()
  })

  it('admin: test connection — failure path', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/test`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.online).toBe(false)

    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(node.status).toBe('error')
    expect(node.last_error).toBeTruthy()
  })

  it('admin: test local node → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${localNodeId}/test`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ─── Catalog sync ─────────────────────────────────────────────────────────────

describe('Catalog sync', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  function buildMockCatalog(overrides?: Partial<FederationCatalogData>): FederationCatalogData {
    const libId = 'lib-remote-1'
    const itemId = 'item-remote-1'
    const versionId = 'ver-remote-1'
    const fileId = 'file-remote-1'
    return {
      nodeId: 'remote-node-id',
      nodeName: 'Remote Helix',
      exportedAt: Date.now(),
      libraries: [{ id: libId, name: 'Remote Movies', kind: 'movies', itemCount: 1 }],
      items: [
        {
          id: itemId,
          library_id: libId,
          parent_id: null,
          kind: 'movie',
          title: 'Synced Movie',
          sort_title: 'Synced Movie',
          year: 2020,
          overview: 'A synced movie',
          has_poster: true,
          has_backdrop: false,
          original_title: null,
          release_date: '2020-01-01',
          content_rating: null,
          runtime_seconds: 7200,
          season_number: null,
          episode_number: null,
          episode_title: null,
          absolute_episode_number: null,
          metadata_status: 'matched',
          external_tmdb_id: '12345',
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
          duration_seconds: 7200,
        },
      ],
      files: [
        {
          id: fileId,
          media_item_id: itemId,
          media_version_id: versionId,
          filename: 'synced-movie.mkv',
          extension: 'mkv',
          size_bytes: 4000000000,
        },
      ],
      ...overrides,
    }
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-sync-${crypto.randomUUID()}`)
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

  it('sync a remote node — imports catalog', async () => {
    // Add remote node
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    const mockCatalog = buildMockCatalog({ nodeId })

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

    // Status should be updated
    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(node.status).toBe('online')
    expect(node.last_sync_at).not.toBeNull()

    // Library should be imported
    const libs = await db.select().from(libraries).where(eq(libraries.node_id, nodeId))
    expect(libs.length).toBe(1)
    expect(libs[0].name).toBe('Remote Movies')

    // Item should be imported with artwork sentinels
    const items = await db.select().from(mediaItems).where(eq(mediaItems.library_id, 'lib-remote-1'))
    expect(items.length).toBe(1)
    expect(items[0].title).toBe('Synced Movie')
    // has_poster=true → sentinel; has_backdrop=false → null
    expect(items[0].poster_path).toBe(`remote-artwork://${nodeId}`)
    expect(items[0].backdrop_path).toBeNull()

    // File should use sentinel path
    const files = await db.select().from(mediaFiles).where(eq(mediaFiles.node_id, nodeId))
    expect(files.length).toBe(1)
    expect(files[0].path).toMatch(/^remote:\/\//)
  })

  it('sync is idempotent — second sync does not duplicate', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    const mockCatalog = buildMockCatalog({ nodeId })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: mockCatalog }),
    }))

    // Sync twice
    await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    // Should still have exactly 1 library and 1 item
    const libs = await db.select().from(libraries).where(eq(libraries.node_id, nodeId))
    expect(libs.length).toBe(1)
    const items = await db.select().from(mediaItems).where(eq(mediaItems.library_id, 'lib-remote-1'))
    expect(items.length).toBe(1)
    const files = await db.select().from(mediaFiles).where(eq(mediaFiles.node_id, nodeId))
    expect(files.length).toBe(1)
  })

  it('sync failure — updates status to error', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(500)

    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(node.status).toBe('error')
    expect(node.last_error).toBeTruthy()
  })

  it('deleting remote node cascades to imported catalog', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id
    const mockCatalog = buildMockCatalog({ nodeId })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: mockCatalog }),
    }))

    await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    // Verify data exists before delete
    const libsBefore = await db.select().from(libraries).where(eq(libraries.node_id, nodeId))
    expect(libsBefore.length).toBe(1)

    // Delete the node
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${nodeId}`,
      headers: { Cookie: adminCookie },
    })

    // Cascade should have removed libraries (and items, versions, files via FK)
    const libsAfter = await db.select().from(libraries).where(eq(libraries.node_id, nodeId))
    expect(libsAfter.length).toBe(0)
    const filesAfter = await db.select().from(mediaFiles).where(eq(mediaFiles.node_id, nodeId))
    expect(filesAfter.length).toBe(0)
  })
})

// ─── Remote item playback ─────────────────────────────────────────────────────

describe('Remote item playback availability', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-remote-play-${crypto.randomUUID()}`)
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

  it('remote-only item reports unavailable with federation message', async () => {
    // Set up a remote node, library, item, and file
    const remoteNodeId = crypto.randomUUID()
    const now = new Date().toISOString()

    await db.insert(nodes).values({
      id: remoteNodeId,
      name: 'Remote',
      kind: 'remote',
      base_url: 'http://remote:3001',
      status: 'online',
      created_at: now,
      updated_at: now,
    })

    const libId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libId,
      node_id: remoteNodeId,
      name: 'Remote Movies',
      kind: 'movies',
      root_path: `remote://${remoteNodeId}`,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    const itemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: itemId,
      library_id: libId,
      parent_id: null,
      kind: 'movie',
      title: 'Remote Movie',
      sort_title: 'Remote Movie',
      metadata_status: 'matched',
      created_at: now,
      updated_at: now,
    })

    const versionId = crypto.randomUUID()
    await db.insert(mediaVersions).values({
      id: versionId,
      media_item_id: itemId,
      label: null,
      quality_label: '1080p',
      resolution_width: 1920,
      resolution_height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      container: 'mkv',
      duration_seconds: 7200,
      created_at: now,
      updated_at: now,
    })

    const fileId = crypto.randomUUID()
    await db.insert(mediaFiles).values({
      id: fileId,
      node_id: remoteNodeId,
      library_id: libId,
      media_item_id: itemId,
      media_version_id: versionId,
      path: `remote://${remoteNodeId}/${fileId}`,
      filename: 'remote.mkv',
      extension: 'mkv',
      size_bytes: 4000000000,
      file_hash: null,
      missing_at: null,
      discovered_at: now,
      updated_at: now,
    })

    // Try to get playback source via the media endpoint
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.unavailable).toBe(true)
    expect(body.data.reason).toMatch(/remote/i)
  })
})
