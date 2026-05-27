/**
 * Phase 17 tests: federation capabilities endpoint, playback-intent contract,
 * node capability sync, enriched playback-source responses.
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
import { nodes, libraries, mediaItems, mediaVersions, mediaFiles } from '../src/db/schema'
import { encryptApiKey } from '../src/services/integrations/encryption'
import type { NodeCapabilities } from '../src/services/federation/capabilities'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

// ─── Capabilities endpoint ────────────────────────────────────────────────────

describe('GET /api/v1/federation/capabilities', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-caps-${crypto.randomUUID()}`)
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

  it('missing token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/federation/capabilities' })
    expect(res.statusCode).toBe(401)
  })

  it('invalid token → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/capabilities',
      headers: { Authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('session cookie is NOT accepted', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/capabilities',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(401)
  })

  it('valid token → 200 with correct capability shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/capabilities',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)

    const caps: NodeCapabilities = body.data
    expect(caps.nodeId).toBe(localNodeId)
    expect(typeof caps.nodeName).toBe('string')
    expect(typeof caps.version).toBe('string')
    expect(typeof caps.federationProtocolVersion).toBe('string')
    expect(caps.supportsCatalogSync).toBe(true)
    expect(caps.supportsArtworkProxy).toBe(true)
    expect(caps.supportsRemotePlayback).toBe(true)
    expect(Array.isArray(caps.supportedPlaybackModes)).toBe(true)
    expect(caps.supportedPlaybackModes).toContain('direct')
    expect(caps.supportsSignedPlaybackUrls).toBe(true)
    expect(typeof caps.directPlaybackUrlTtlSeconds).toBe('number')
    expect(caps.directPlaybackUrlTtlSeconds).toBeGreaterThan(0)
  })
})

// ─── Playback-intent endpoint ─────────────────────────────────────────────────

describe('POST /api/v1/federation/playback-intent', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-intent-${crypto.randomUUID()}`)
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

  it('missing token → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/federation/playback-intent' })
    expect(res.statusCode).toBe(401)
  })

  it('invalid token → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/playback-intent',
      headers: { Authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('valid token with unknown item → 200 with unavailable status (file not found)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/playback-intent',
      headers: { Authorization: `Bearer ${rawToken}` },
      payload: { mediaItemId: 'some-nonexistent-id', requestedMode: 'direct' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('unavailable')
    expect(body.data.reason).toBe('file_missing')
  })

  it('valid token with unsupported mode → 200 with unsupported status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/playback-intent',
      headers: { Authorization: `Bearer ${rawToken}` },
      payload: { mediaItemId: 'some-id', requestedMode: 'transcode' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('unsupported')
    expect(typeof body.data.reason).toBe('string')
    expect(body.data.reason.length).toBeGreaterThan(0)
  })

  it('valid token with no body → 400 (missing required identifiers)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/playback-intent',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ─── Node test stores capabilities ───────────────────────────────────────────

describe('Node test — stores capabilities when remote returns them', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-nodecaps-${crypto.randomUUID()}`)
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

  it('test connection — capabilities stored and returned when remote supports them', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    const mockCaps: NodeCapabilities = {
      nodeId: 'remote-node-uuid',
      nodeName: 'Remote',
      version: '0.1.0',
      federationProtocolVersion: '1',
      supportsCatalogSync: true,
      supportsArtworkProxy: true,
      supportsRemotePlayback: false,
      supportedPlaybackModes: [],
      supportsSignedPlaybackUrls: false,
      directPlaybackUrlTtlSeconds: 14400,
    }

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { status: 'online' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: mockCaps }),
      })
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/test`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.online).toBe(true)
    expect(body.data.capabilities).toBeTruthy()
    expect(body.data.capabilities.supportsCatalogSync).toBe(true)
    expect(body.data.capabilities.supportsRemotePlayback).toBe(false)

    // Verify stored in DB
    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(node.capabilities_json).not.toBeNull()
    const stored = JSON.parse(node.capabilities_json!)
    expect(stored.supportsCatalogSync).toBe(true)
  })

  it('test connection — capabilities null when remote does not support endpoint', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote Old', base_url: 'http://remote-old:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { status: 'online' } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })  // caps not supported
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/test`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.online).toBe(true)
    expect(body.data.capabilities).toBeNull()

    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(node.capabilities_json).toBeNull()
  })

  it('node list includes parsed capabilities field', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    // Manually set capabilities_json in DB
    const caps: NodeCapabilities = {
      nodeId,
      nodeName: 'Remote',
      version: '0.1.0',
      federationProtocolVersion: '1',
      supportsCatalogSync: true,
      supportsArtworkProxy: true,
      supportsRemotePlayback: false,
      supportedPlaybackModes: [],
      supportsSignedPlaybackUrls: false,
      directPlaybackUrlTtlSeconds: 14400,
    }
    await db.update(nodes).set({ capabilities_json: JSON.stringify(caps) }).where(eq(nodes.id, nodeId))

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
    })
    const listBody = JSON.parse(listRes.body)
    const remote = listBody.data.find((n: { kind: string }) => n.kind === 'remote')
    expect(remote.capabilities).toBeTruthy()
    expect(remote.capabilities.supportsRemotePlayback).toBe(false)
    // Raw JSON string must not be present
    expect(remote.capabilities_json).toBeUndefined()
  })
})

// ─── Playback-source: local unchanged ────────────────────────────────────────

describe('playback-source: local item behavior unchanged', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let libraryId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-pbs-local-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Movies',
      kind: 'movies',
      root_path: testDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    app = buildServer(db, localNodeId, 'http://localhost:3001', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('local playable item returns code=local_playable with nodeKind=local', async () => {
    const filePath = join(testDir, 'movie.mp4')
    writeFileSync(filePath, Buffer.from('fake video'))
    const now = new Date().toISOString()

    const itemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: itemId, library_id: libraryId, kind: 'movie', title: 'Movie', sort_title: 'Movie',
      metadata_status: 'unknown', created_at: now, updated_at: now,
    })
    const verId = crypto.randomUUID()
    await db.insert(mediaVersions).values({
      id: verId, media_item_id: itemId, quality_label: '1080p',
      resolution_width: 1920, resolution_height: 1080,
      container: 'mp4', duration_seconds: 7200,
      created_at: now, updated_at: now,
    })
    const fileId = crypto.randomUUID()
    await db.insert(mediaFiles).values({
      id: fileId, node_id: localNodeId, library_id: libraryId,
      media_item_id: itemId, media_version_id: verId,
      path: filePath, filename: 'movie.mp4', extension: 'mp4',
      size_bytes: 10, file_hash: null, discovered_at: now, updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.source).toBeDefined()
    expect(body.data.source.code).toBe('local_playable')
    expect(body.data.source.nodeKind).toBe('local')
    expect(typeof body.data.source.nodeName).toBe('string')
    expect(body.data.source.streamUrl).toContain('/stream')
    expect(body.data.source.fileId).toBe(fileId)
    // Aliases must be consistent
    expect(body.data.source.selectedFileId).toBe(fileId)
    expect(body.data.source.selectedVersionId).toBe(verId)
    // No remote token in response
    expect(JSON.stringify(body.data)).not.toContain('api_token')
    expect(JSON.stringify(body.data)).not.toContain('federation_token')
  })
})

// ─── Playback-source: remote-only item ───────────────────────────────────────

describe('playback-source: remote-only item', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let remoteNodeId: string
  let itemId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-pbs-remote-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://localhost:3001', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    const now = new Date().toISOString()
    remoteNodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: remoteNodeId, name: 'Living Room', kind: 'remote',
      base_url: 'http://living-room:3001', status: 'online',
      api_token_encrypted: encryptApiKey('tok', testDir),
      created_at: now, updated_at: now,
    })
    const libId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libId, node_id: remoteNodeId, name: 'Remote Movies', kind: 'movies',
      root_path: `remote://${remoteNodeId}`, scan_status: 'idle',
      created_at: now, updated_at: now,
    })
    itemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: itemId, library_id: libId, kind: 'movie', title: 'Remote Movie',
      sort_title: 'Remote Movie', metadata_status: 'matched',
      created_at: now, updated_at: now,
    })
    const verId = crypto.randomUUID()
    await db.insert(mediaVersions).values({
      id: verId, media_item_id: itemId, quality_label: '1080p',
      resolution_width: 1920, resolution_height: 1080,
      container: 'mkv', duration_seconds: 7200,
      created_at: now, updated_at: now,
    })
    const fileId = crypto.randomUUID()
    await db.insert(mediaFiles).values({
      id: fileId, node_id: remoteNodeId, library_id: libId,
      media_item_id: itemId, media_version_id: verId,
      path: `remote://${remoteNodeId}/${fileId}`,
      filename: 'remote.mkv', extension: 'mkv',
      size_bytes: 4000000000, file_hash: null,
      discovered_at: now, updated_at: now,
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('returns code=remote_playback_unsupported with node info', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.unavailable).toBe(true)
    expect(body.data.code).toBe('remote_playback_unsupported')
    expect(body.data.nodeName).toBe('Living Room')
    expect(body.data.nodeId).toBe(remoteNodeId)
    expect(body.data.nodeKind).toBe('remote')
    expect(body.data.reason).toMatch(/Living Room/i)
    expect(body.data.reason).toMatch(/remote playback/i)
  })

  it('does not leak raw remote token or filesystem paths', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    const raw = res.body
    expect(raw).not.toContain('api_token')
    expect(raw).not.toContain('federation_token')
    expect(raw).not.toContain('encrypted')
    // No real filesystem path — only sentinel
    expect(raw).not.toMatch(/\/home\//)
    expect(raw).not.toMatch(/\/tmp\//)
  })

  it('capabilities stored on node feed remote_playback_unsupported even when caps say false', async () => {
    // Set capabilities that explicitly say supportsRemotePlayback: false
    const caps = {
      nodeId: remoteNodeId, nodeName: 'Living Room', version: '0.1.0',
      federationProtocolVersion: '1', supportsCatalogSync: true,
      supportsArtworkProxy: true, supportsRemotePlayback: false,
      supportedPlaybackModes: [], supportsSignedPlaybackUrls: false,
    }
    await db.update(nodes)
      .set({ capabilities_json: JSON.stringify(caps) })
      .where(eq(nodes.id, remoteNodeId))

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.data.code).toBe('remote_playback_unsupported')
  })
})

// ─── Playback-source: local preferred over remote ────────────────────────────

describe('playback-source: local source preferred when both exist', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-pbs-prefer-${crypto.randomUUID()}`)
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

  it('returns local source when both local and remote files exist', async () => {
    const now = new Date().toISOString()

    // Set up remote node
    const remoteNodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: remoteNodeId, name: 'Remote Hub', kind: 'remote',
      base_url: 'http://remote:3001', status: 'online',
      created_at: now, updated_at: now,
    })

    // Shared local library
    const libId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libId, node_id: localNodeId, name: 'Movies', kind: 'movies',
      root_path: testDir, scan_status: 'idle', created_at: now, updated_at: now,
    })

    // Media item
    const itemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: itemId, library_id: libId, kind: 'movie', title: 'Dual Movie',
      sort_title: 'Dual Movie', metadata_status: 'matched',
      created_at: now, updated_at: now,
    })

    // Local version + file
    const localVerId = crypto.randomUUID()
    await db.insert(mediaVersions).values({
      id: localVerId, media_item_id: itemId, quality_label: '1080p',
      resolution_width: 1920, resolution_height: 1080, container: 'mp4',
      duration_seconds: 7200, created_at: now, updated_at: now,
    })
    const filePath = join(testDir, 'dual-movie.mp4')
    writeFileSync(filePath, Buffer.from('local video'))
    const localFileId = crypto.randomUUID()
    await db.insert(mediaFiles).values({
      id: localFileId, node_id: localNodeId, library_id: libId,
      media_item_id: itemId, media_version_id: localVerId,
      path: filePath, filename: 'dual-movie.mp4', extension: 'mp4',
      size_bytes: 11, file_hash: null, discovered_at: now, updated_at: now,
    })

    // Remote version + sentinel file (different version for simplicity)
    const remoteLibId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: remoteLibId, node_id: remoteNodeId, name: 'Remote Movies', kind: 'movies',
      root_path: `remote://${remoteNodeId}`, scan_status: 'idle',
      created_at: now, updated_at: now,
    })
    const remoteVerId = crypto.randomUUID()
    await db.insert(mediaVersions).values({
      id: remoteVerId, media_item_id: itemId, quality_label: '720p',
      resolution_width: 1280, resolution_height: 720, container: 'mkv',
      duration_seconds: 7200, created_at: now, updated_at: now,
    })
    const remoteFileId = crypto.randomUUID()
    await db.insert(mediaFiles).values({
      id: remoteFileId, node_id: remoteNodeId, library_id: remoteLibId,
      media_item_id: itemId, media_version_id: remoteVerId,
      path: `remote://${remoteNodeId}/${remoteFileId}`,
      filename: 'remote.mkv', extension: 'mkv',
      size_bytes: 1000000, file_hash: null, discovered_at: now, updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    // Local source should be preferred
    expect(body.data.source).toBeDefined()
    expect(body.data.source.code).toBe('local_playable')
    expect(body.data.source.fileId).toBe(localFileId)
    expect(body.data.source.nodeKind).toBe('local')
    // No unavailable — we have local
    expect(body.data.unavailable).toBeUndefined()
  })
})

// ─── Node sync — capabilities fetched alongside catalog ──────────────────────

describe('Node sync — capabilities fetched alongside catalog', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-sync-caps-${crypto.randomUUID()}`)
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

  it('sync stores capabilities when remote endpoint is available', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: 'http://remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    const mockCaps: NodeCapabilities = {
      nodeId, nodeName: 'Remote', version: '0.1.0',
      federationProtocolVersion: '1', supportsCatalogSync: true,
      supportsArtworkProxy: true, supportsRemotePlayback: false,
      supportedPlaybackModes: [], supportsSignedPlaybackUrls: false,
      directPlaybackUrlTtlSeconds: 14400,
    }

    const emptyCatalog = {
      nodeId, nodeName: 'Remote', exportedAt: Date.now(),
      libraries: [], items: [], versions: [], files: [],
    }

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: emptyCatalog }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: mockCaps }),
      })
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.capabilities).not.toBeNull()
    expect(body.data.capabilities.supportsCatalogSync).toBe(true)

    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(node.capabilities_json).not.toBeNull()
  })

  it('sync still succeeds when capabilities endpoint is absent (graceful degrade)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'OldRemote', base_url: 'http://old-remote:3001', api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id

    const emptyCatalog = {
      nodeId, nodeName: 'OldRemote', exportedAt: Date.now(),
      libraries: [], items: [], versions: [], files: [],
    }

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: emptyCatalog }),
      })
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))  // caps fetch fails
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.synced).toBe(true)
    expect(body.data.capabilities).toBeNull()

    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    expect(node.capabilities_json).toBeNull()
  })
})
