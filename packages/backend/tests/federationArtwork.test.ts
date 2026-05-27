/**
 * Federation artwork proxy tests.
 * - Federation artwork endpoint: token auth, 404 cases, serves file
 * - Hub proxy: session auth, permission check, remote call, offline handling
 * - API responses: remote items get proxy URLs, local items get signed URLs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { setupAuth } from './helpers/auth'
import { nodes, libraries, mediaItems, mediaFiles, mediaVersions } from '../src/db/schema'
import { encryptApiKey } from '../src/services/integrations/encryption'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

// ─── Federation artwork endpoint ──────────────────────────────────────────────

describe('Federation artwork endpoint', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawToken: string
  let artworkFile: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-fed-artwork-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    // Generate federation token
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    rawToken = JSON.parse(tokenRes.body).data.token

    // Create a real artwork file on disk
    artworkFile = join(testDir, 'poster.jpg')
    writeFileSync(artworkFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('missing token → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/media/no-such-id/artwork/poster',
    })
    expect(res.statusCode).toBe(401)
  })

  it('invalid token → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/media/no-such-id/artwork/poster',
      headers: { Authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('invalid kind → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/media/no-such-id/artwork/thumbnail',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('item not found → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/media/no-such-id/artwork/poster',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('item exists but has no artwork → 404', async () => {
    const now = new Date().toISOString()
    const libId = crypto.randomUUID()
    const itemId = crypto.randomUUID()

    await db.insert(libraries).values({
      id: libId,
      node_id: localNodeId,
      name: 'Test Lib',
      kind: 'movies',
      root_path: testDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })
    await db.insert(mediaItems).values({
      id: itemId,
      library_id: libId,
      kind: 'movie',
      title: 'No Artwork',
      sort_title: 'No Artwork',
      metadata_status: 'unknown',
      created_at: now,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/artwork/poster`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('imported remote item (sentinel path) is rejected → 404', async () => {
    const remoteNodeId = crypto.randomUUID()
    const now = new Date().toISOString()

    // Insert a remote node and its library/item
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
      kind: 'movie',
      title: 'Remote Movie',
      sort_title: 'Remote Movie',
      metadata_status: 'matched',
      poster_path: `remote-artwork://${remoteNodeId}`,
      created_at: now,
      updated_at: now,
    })

    // Remote item belongs to remote node — federation endpoint should 404
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/artwork/poster`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('valid local item with artwork — streams file with correct content-type', async () => {
    const now = new Date().toISOString()
    const libId = crypto.randomUUID()
    const itemId = crypto.randomUUID()

    await db.insert(libraries).values({
      id: libId,
      node_id: localNodeId,
      name: 'Movies',
      kind: 'movies',
      root_path: testDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })
    await db.insert(mediaItems).values({
      id: itemId,
      library_id: libId,
      kind: 'movie',
      title: 'Has Poster',
      sort_title: 'Has Poster',
      metadata_status: 'matched',
      poster_path: artworkFile,
      created_at: now,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/artwork/poster`,
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0)
  })

  it('session cookie is NOT accepted for federation artwork', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/media/some-id/artwork/poster',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── Hub proxy ────────────────────────────────────────────────────────────────

describe('Hub proxy: GET /nodes/:nodeId/media/:mediaId/artwork/:kind', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let remoteNodeId: string
  let libId: string
  let itemId: string

  async function setupRemoteItem() {
    const now = new Date().toISOString()
    remoteNodeId = crypto.randomUUID()

    await db.insert(nodes).values({
      id: remoteNodeId,
      name: 'Remote Hub',
      kind: 'remote',
      base_url: 'http://remote-hub:3001',
      status: 'online',
      api_token_encrypted: encryptApiKey('remote-federation-token', testDir),
      created_at: now,
      updated_at: now,
    })

    libId = crypto.randomUUID()
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

    itemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: itemId,
      library_id: libId,
      kind: 'movie',
      title: 'Remote Movie',
      sort_title: 'Remote Movie',
      metadata_status: 'matched',
      poster_path: `remote-artwork://${remoteNodeId}`,
      created_at: now,
      updated_at: now,
    })
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-hub-proxy-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
    await setupRemoteItem()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('unauthenticated → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/artwork/poster`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('invalid kind → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/artwork/thumbnail`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(400)
  })

  it('item not found in local DB → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/no-such-item/artwork/poster`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('unknown remote node → 404', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/unknown-node/media/${itemId}/artwork/poster`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('remote node unreachable → 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/artwork/poster`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(502)
  })

  it('remote node returns 404 → 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/artwork/poster`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('remote node returns 500 → 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/artwork/poster`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(502)
  })

  it('successful proxy — streams image with correct content-type', async () => {
    const fakeImage = Buffer.from([0xff, 0xd8, 0xff, 0xe0])

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h: string) => h === 'content-type' ? 'image/jpeg' : null },
      arrayBuffer: async () => fakeImage.buffer.slice(
        fakeImage.byteOffset,
        fakeImage.byteOffset + fakeImage.byteLength
      ),
    }))

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/artwork/poster`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(Number(res.headers['content-length'])).toBe(fakeImage.length)
  })

  it('proxy uses federation token — does not expose token to client', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h: string) => h === 'content-type' ? 'image/png' : null },
      arrayBuffer: async () => new ArrayBuffer(4),
    })
    vi.stubGlobal('fetch', fetchMock)

    await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/artwork/poster`,
      headers: { Cookie: adminCookie },
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]
    expect(calledUrl).toContain('/api/v1/federation/media/')
    expect(calledUrl).toContain('/artwork/poster')
    // Uses Bearer federation token (decrypted remote-federation-token)
    expect(calledInit.headers.Authorization).toMatch(/^Bearer .+/)
    // The raw token is NOT the admin session cookie
    expect(calledInit.headers.Authorization).not.toContain('helix_session')
  })
})

// ─── API response artwork URLs ────────────────────────────────────────────────

describe('API response: proxy URLs for remote items', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-art-url-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://localhost:3001', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('remote item with sentinel → posterUrl is hub proxy URL', async () => {
    const now = new Date().toISOString()
    const remoteNodeId = crypto.randomUUID()

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
      kind: 'movie',
      title: 'Remote Movie',
      sort_title: 'Remote Movie',
      metadata_status: 'matched',
      poster_path: `remote-artwork://${remoteNodeId}`,
      backdrop_path: null,
      created_at: now,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    // posterUrl should be hub proxy, not raw path
    expect(body.data.posterUrl).toBe(
      `http://localhost:3001/api/v1/nodes/${remoteNodeId}/media/${itemId}/artwork/poster`
    )
    expect(body.data.backdropUrl).toBeNull()
    // No raw paths leaked
    expect(body.data.poster_path).toBeUndefined()
    expect(body.data.backdrop_path).toBeUndefined()
  })

  it('local item with real artwork → posterUrl is signed URL', async () => {
    const now = new Date().toISOString()
    const libId = crypto.randomUUID()

    await db.insert(libraries).values({
      id: libId,
      node_id: localNodeId,
      name: 'Local Movies',
      kind: 'movies',
      root_path: testDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    const itemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: itemId,
      library_id: libId,
      kind: 'movie',
      title: 'Local Movie',
      sort_title: 'Local Movie',
      metadata_status: 'matched',
      poster_path: join(testDir, 'poster.jpg'),
      created_at: now,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.posterUrl).toContain('/api/v1/media/')
    expect(body.data.posterUrl).toContain('/artwork/poster')
    expect(body.data.posterUrl).toContain('?token=')
    // No proxy path pattern for local items
    expect(body.data.posterUrl).not.toContain('/api/v1/nodes/')
  })

  it('item with no artwork → posterUrl is null', async () => {
    const now = new Date().toISOString()
    const libId = crypto.randomUUID()

    await db.insert(libraries).values({
      id: libId,
      node_id: localNodeId,
      name: 'Local Movies',
      kind: 'movies',
      root_path: testDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    const itemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: itemId,
      library_id: libId,
      kind: 'movie',
      title: 'No Art',
      sort_title: 'No Art',
      metadata_status: 'unknown',
      created_at: now,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.posterUrl).toBeNull()
    expect(body.data.backdropUrl).toBeNull()
  })
})

// ─── Catalog sync → artwork sentinels ────────────────────────────────────────

describe('Catalog sync preserves has_poster/has_backdrop as sentinels', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-sync-art-${crypto.randomUUID()}`)
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

  it('has_poster=true → poster_path set to remote-artwork sentinel', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id
    const itemId = 'item-sentinel-1'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          nodeId,
          nodeName: 'Remote',
          exportedAt: Date.now(),
          libraries: [{ id: 'lib-sentinel-1', name: 'Movies', kind: 'movies', itemCount: 1 }],
          items: [{
            id: itemId,
            library_id: 'lib-sentinel-1',
            parent_id: null,
            kind: 'movie',
            title: 'Poster Movie',
            sort_title: 'Poster Movie',
            year: 2024,
            overview: null,
            has_poster: true,
            has_backdrop: true,
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
          }],
          versions: [],
          files: [],
        },
      }),
    }))

    await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    const [item] = await db.select().from(mediaItems).where(eq(mediaItems.id, itemId))
    expect(item.poster_path).toBe(`remote-artwork://${nodeId}`)
    expect(item.backdrop_path).toBe(`remote-artwork://${nodeId}`)
  })

  it('has_poster=false → poster_path stays null', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote2', base_url: 'http://remote2:3001', api_token: 'tok2' },
    })
    const nodeId = JSON.parse(createRes.body).data.id
    const itemId = 'item-no-art-1'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          nodeId,
          nodeName: 'Remote2',
          exportedAt: Date.now(),
          libraries: [{ id: 'lib-no-art-1', name: 'Movies', kind: 'movies', itemCount: 1 }],
          items: [{
            id: itemId,
            library_id: 'lib-no-art-1',
            parent_id: null,
            kind: 'movie',
            title: 'No Art Movie',
            sort_title: 'No Art Movie',
            year: null,
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
            metadata_status: 'unknown',
            external_tmdb_id: null,
            external_tvdb_id: null,
            updated_at: new Date().toISOString(),
          }],
          versions: [],
          files: [],
        },
      }),
    }))

    await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })

    const [item] = await db.select().from(mediaItems).where(eq(mediaItems.id, itemId))
    expect(item.poster_path).toBeNull()
    expect(item.backdrop_path).toBeNull()
  })
})
