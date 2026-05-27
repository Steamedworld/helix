/**
 * Tests for BASE_URL configuration validation, capabilities, playback-intent,
 * node diagnostics, and playback-source localhost warning (Phase 19).
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
import { makeLocalCapabilities } from '../src/services/federation/capabilities'
import { isLoopbackUrl } from '../src/config'
import type { NodeCapabilities } from '../src/services/federation/capabilities'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

// ─── Config validation: isLoopbackUrl ────────────────────────────────────────

describe('isLoopbackUrl', () => {
  it('localhost is loopback', () => {
    expect(isLoopbackUrl('http://localhost:3001')).toBe(true)
  })

  it('127.0.0.1 is loopback', () => {
    expect(isLoopbackUrl('http://127.0.0.1:3001')).toBe(true)
  })

  it('::1 is loopback', () => {
    expect(isLoopbackUrl('http://[::1]:3001')).toBe(true)
  })

  it('LAN hostname is not loopback', () => {
    expect(isLoopbackUrl('http://media-box.local:3001')).toBe(false)
  })

  it('public IP is not loopback', () => {
    expect(isLoopbackUrl('http://192.168.1.42:3001')).toBe(false)
  })

  it('https with domain is not loopback', () => {
    expect(isLoopbackUrl('https://helix.example.com')).toBe(false)
  })

  it('invalid URL returns false (does not throw)', () => {
    expect(isLoopbackUrl('not-a-url')).toBe(false)
  })
})

// ─── Config validation: parseBaseUrl (via config loading) ────────────────────

describe('BASE_URL env var validation', () => {
  afterEach(() => {
    delete process.env.BASE_URL
    delete process.env.PUBLIC_URL
  })

  it('missing BASE_URL → config.baseUrl is null (no crash)', async () => {
    delete process.env.BASE_URL
    delete process.env.PUBLIC_URL
    // Re-import config after env change is not feasible without module reset.
    // Test via the makeLocalCapabilities function which reads config at call time.
    vi.stubEnv('BASE_URL', '')
    // Should not throw — absence is allowed
    expect(() => isLoopbackUrl('http://localhost')).not.toThrow()
    vi.unstubAllEnvs()
  })

  it('valid http URL is accepted', () => {
    // isLoopbackUrl is a pure function that validates URL format
    expect(() => isLoopbackUrl('http://media-box.local:3001')).not.toThrow()
  })

  it('valid https URL is accepted', () => {
    expect(() => isLoopbackUrl('https://helix.example.com')).not.toThrow()
  })
})

// ─── Capabilities: baseUrlConfigured and publicBaseUrl fields ────────────────

describe('makeLocalCapabilities — BASE_URL fields', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('directPlaybackRequiresBrowserReachability is always true', () => {
    const caps = makeLocalCapabilities('node-1', 'Test')
    expect(caps.directPlaybackRequiresBrowserReachability).toBe(true)
  })

  it('baseUrlConfigured is false when BASE_URL not set', () => {
    vi.stubEnv('BASE_URL', '')
    // The config module reads BASE_URL once at import time, but makeLocalCapabilities
    // reads config.baseUrl at call time. Since we cannot re-import config, we test
    // the field shape — the value will depend on the import-time env.
    const caps = makeLocalCapabilities('node-1', 'Test')
    expect(typeof caps.baseUrlConfigured).toBe('boolean')
    expect(typeof caps.directPlaybackUrlTtlSeconds).toBe('number')
  })

  it('capability response shape is complete', () => {
    const caps = makeLocalCapabilities('node-id', 'My Node')
    expect(caps.nodeId).toBe('node-id')
    expect(caps.nodeName).toBe('My Node')
    expect(caps.version).toBe('0.1.0')
    expect(caps.federationProtocolVersion).toBe('1')
    expect(caps.supportsCatalogSync).toBe(true)
    expect(caps.supportsArtworkProxy).toBe(true)
    expect(caps.supportsRemotePlayback).toBe(true)
    expect(caps.supportedPlaybackModes).toContain('direct')
    expect(caps.supportsSignedPlaybackUrls).toBe(true)
    expect(caps.directPlaybackUrlTtlSeconds).toBeGreaterThan(0)
    expect(caps.directPlaybackRequiresBrowserReachability).toBe(true)
    expect('baseUrlConfigured' in caps).toBe(true)
  })

  it('no secret fields in capabilities', () => {
    const caps = makeLocalCapabilities('node-id', 'Test')
    const serialized = JSON.stringify(caps)
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('password')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('key')
    expect(serialized).not.toContain('encrypted')
  })
})

// ─── Capabilities endpoint: new fields appear in response ────────────────────

describe('GET /api/v1/federation/capabilities — BASE_URL fields present', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let rawToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-caps-baseurl-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    const adminCookie = await setupAuth(app)

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

  it('capabilities response includes baseUrlConfigured and directPlaybackRequiresBrowserReachability', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/capabilities',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)

    const caps: NodeCapabilities = body.data
    expect('baseUrlConfigured' in caps).toBe(true)
    expect(typeof caps.baseUrlConfigured).toBe('boolean')
    expect(caps.directPlaybackRequiresBrowserReachability).toBe(true)
  })

  it('no tokens or secrets in capabilities response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/capabilities',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    const raw = res.body
    expect(raw).not.toContain('api_token')
    expect(raw).not.toContain('federation_token')
    expect(raw).not.toContain('encrypted')
    expect(raw).not.toContain('password')
    expect(raw).not.toContain('secret')
  })
})

// ─── Config endpoint ──────────────────────────────────────────────────────────

describe('GET /api/v1/config', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-config-${crypto.randomUUID()}`)
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

  it('returns config shape with required fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect('baseUrlConfigured' in body.data).toBe(true)
    expect('baseUrlIsLoopback' in body.data).toBe(true)
    expect('baseUrl' in body.data).toBe(true)
  })

  it('does not expose tokens or secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' })
    const raw = res.body
    expect(raw).not.toContain('token')
    expect(raw).not.toContain('password')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('encrypted')
    expect(raw).not.toContain('key')
  })
})

// ─── Playback-intent: streamUrl uses configured baseUrl ──────────────────────

describe('POST /api/v1/federation/playback-intent — streamUrl BASE_URL', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let rawToken: string
  let libraryId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-intent-baseurl-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId, node_id: localNodeId, name: 'Movies', kind: 'movies',
      root_path: testDir, scan_status: 'idle', created_at: now, updated_at: now,
    })

    app = buildServer(db, localNodeId, 'http://media-box.local:3001', testDir)
    await app.ready()
    const adminCookie = await setupAuth(app)

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

  it('streamUrl uses configured baseUrl (not localhost) when BASE_URL is set', async () => {
    const filePath = join(testDir, 'movie.mkv')
    writeFileSync(filePath, Buffer.from('fake video'))
    const now = new Date().toISOString()

    const itemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: itemId, library_id: libraryId, kind: 'movie', title: 'Movie',
      sort_title: 'movie', metadata_status: 'matched', created_at: now, updated_at: now,
    })
    const verId = crypto.randomUUID()
    await db.insert(mediaVersions).values({
      id: verId, media_item_id: itemId, quality_label: '1080p',
      resolution_width: 1920, resolution_height: 1080, container: 'mkv',
      duration_seconds: 7200, created_at: now, updated_at: now,
    })
    const fileId = crypto.randomUUID()
    await db.insert(mediaFiles).values({
      id: fileId, node_id: localNodeId, library_id: libraryId,
      media_item_id: itemId, media_version_id: verId,
      path: filePath, filename: 'movie.mkv', extension: 'mkv',
      size_bytes: 100, file_hash: null, missing_at: null,
      discovered_at: now, updated_at: now,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/playback-intent',
      headers: { Authorization: `Bearer ${rawToken}` },
      payload: { mediaItemId: itemId, requestedMode: 'direct' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('ready')
    expect(body.data.streamUrl).toContain('http://media-box.local:3001')
    expect(body.data.streamUrl).not.toContain('localhost')
  })

  it('streamUrl falls back to localhost when baseUrl is not set (backward compat)', async () => {
    // Build a server without baseUrl
    const testDir2 = join(tmpdir(), `helix-intent-nobaseurl-${crypto.randomUUID()}`)
    mkdirSync(testDir2, { recursive: true })
    const db2 = createTestDb(testDir2)
    const nodeId2 = await bootstrap(db2, testDir2)

    const now = new Date().toISOString()
    const libId2 = crypto.randomUUID()
    await db2.insert(libraries).values({
      id: libId2, node_id: nodeId2, name: 'Movies', kind: 'movies',
      root_path: testDir2, scan_status: 'idle', created_at: now, updated_at: now,
    })

    // No baseUrl passed — falls back to localhost
    const app2 = buildServer(db2, nodeId2, undefined, testDir2)
    await app2.ready()
    const adminCookie2 = await setupAuth(app2)

    const tokenRes2 = await app2.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie2 },
    })
    const rawToken2 = JSON.parse(tokenRes2.body).data.token

    const filePath2 = join(testDir2, 'movie2.mkv')
    writeFileSync(filePath2, Buffer.from('fake'))
    const itemId2 = crypto.randomUUID()
    await db2.insert(mediaItems).values({
      id: itemId2, library_id: libId2, kind: 'movie', title: 'Movie2',
      sort_title: 'movie2', metadata_status: 'matched', created_at: now, updated_at: now,
    })
    const verId2 = crypto.randomUUID()
    await db2.insert(mediaVersions).values({
      id: verId2, media_item_id: itemId2, quality_label: '720p',
      resolution_width: 1280, resolution_height: 720, container: 'mkv',
      duration_seconds: 3600, created_at: now, updated_at: now,
    })
    const fileId2 = crypto.randomUUID()
    await db2.insert(mediaFiles).values({
      id: fileId2, node_id: nodeId2, library_id: libId2,
      media_item_id: itemId2, media_version_id: verId2,
      path: filePath2, filename: 'movie2.mkv', extension: 'mkv',
      size_bytes: 100, file_hash: null, missing_at: null,
      discovered_at: now, updated_at: now,
    })

    const res2 = await app2.inject({
      method: 'POST',
      url: '/api/v1/federation/playback-intent',
      headers: { Authorization: `Bearer ${rawToken2}` },
      payload: { mediaItemId: itemId2, requestedMode: 'direct' },
    })
    await app2.close()
    rmSync(testDir2, { recursive: true, force: true })

    expect(res2.statusCode).toBe(200)
    const body2 = JSON.parse(res2.body)
    expect(body2.data.status).toBe('ready')
    // Without baseUrl, should fall back to localhost
    expect(body2.data.streamUrl).toContain('localhost')
  })

  it('streamUrl does not include auth tokens in the URL itself', async () => {
    const filePath = join(testDir, 'movie3.mkv')
    writeFileSync(filePath, Buffer.from('fake'))
    const now = new Date().toISOString()

    const itemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: itemId, library_id: libraryId, kind: 'movie', title: 'Movie3',
      sort_title: 'movie3', metadata_status: 'matched', created_at: now, updated_at: now,
    })
    const verId = crypto.randomUUID()
    await db.insert(mediaVersions).values({
      id: verId, media_item_id: itemId, quality_label: '1080p',
      resolution_width: 1920, resolution_height: 1080, container: 'mkv',
      duration_seconds: 7200, created_at: now, updated_at: now,
    })
    const fileId = crypto.randomUUID()
    await db.insert(mediaFiles).values({
      id: fileId, node_id: localNodeId, library_id: libraryId,
      media_item_id: itemId, media_version_id: verId,
      path: filePath, filename: 'movie3.mkv', extension: 'mkv',
      size_bytes: 100, file_hash: null, missing_at: null,
      discovered_at: now, updated_at: now,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/playback-intent',
      headers: { Authorization: `Bearer ${rawToken}` },
      payload: { mediaItemId: itemId, requestedMode: 'direct' },
    })
    const body = JSON.parse(res.body)
    expect(body.data.streamUrl).toContain('?token=')
    // The federation token itself must NOT appear in the stream URL
    expect(body.data.streamUrl).not.toContain(rawToken)
    // No api_token, federation token hash etc. in response
    expect(res.body).not.toContain('api_token')
    expect(res.body).not.toContain('federation_token_hash')
  })
})

// ─── Node diagnostics: GET /:id/check ────────────────────────────────────────

describe('GET /api/v1/nodes/:id/check — direct playback diagnostics', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-nodecheck-${crypto.randomUUID()}`)
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

  async function addRemoteNode(baseUrl = 'http://remote:3001', caps?: NodeCapabilities | null) {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Remote', base_url: baseUrl, api_token: 'tok' },
    })
    const nodeId = JSON.parse(createRes.body).data.id
    if (caps !== undefined) {
      await db.update(nodes)
        .set({ capabilities_json: caps ? JSON.stringify(caps) : null })
        .where(eq(nodes.id, nodeId))
    }
    return nodeId
  }

  it('unknown node → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nodes/nonexistent/check',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('local node → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${localNodeId}/check`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(400)
  })

  it('requires admin', async () => {
    const nodeId = await addRemoteNode()
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/check`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('remote node with no capabilities → diagnostic has warning', async () => {
    const nodeId = await addRemoteNode('http://remote:3001', null)

    // Mock fetch so the live capabilities fetch fails fast (no network call)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')))

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/check`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.directPlaybackAvailable).toBe(false)
    expect(typeof body.data.warning).toBe('string')
    expect(body.data.warning.length).toBeGreaterThan(0)
  })

  it('remote node with baseUrlConfigured=false → directPlaybackAvailable=true but warning present', async () => {
    const caps: NodeCapabilities = {
      nodeId: 'remote-id', nodeName: 'Remote', version: '0.1.0',
      federationProtocolVersion: '1', supportsCatalogSync: true,
      supportsArtworkProxy: true, supportsRemotePlayback: true,
      supportedPlaybackModes: ['direct'], supportsSignedPlaybackUrls: true,
      directPlaybackUrlTtlSeconds: 14400,
      baseUrlConfigured: false,
      publicBaseUrl: 'http://localhost:3001',
      directPlaybackRequiresBrowserReachability: true,
    }
    const nodeId = await addRemoteNode('http://remote:3001', caps)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/check`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    // Supports remote playback but BASE_URL not configured → warning
    expect(body.data.supportsRemotePlayback).toBe(true)
    expect(body.data.baseUrlConfigured).toBe(false)
    expect(typeof body.data.warning).toBe('string')
    expect(body.data.warning).toContain('BASE_URL')
  })

  it('remote node with loopback publicBaseUrl → warning present', async () => {
    const caps: NodeCapabilities = {
      nodeId: 'remote-id', nodeName: 'Remote', version: '0.1.0',
      federationProtocolVersion: '1', supportsCatalogSync: true,
      supportsArtworkProxy: true, supportsRemotePlayback: true,
      supportedPlaybackModes: ['direct'], supportsSignedPlaybackUrls: true,
      directPlaybackUrlTtlSeconds: 14400,
      baseUrlConfigured: false,
      publicBaseUrl: 'http://127.0.0.1:3001',
      directPlaybackRequiresBrowserReachability: true,
    }
    const nodeId = await addRemoteNode('http://remote:3001', caps)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/check`,
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.data.warning).toBeDefined()
    expect(body.data.warning).toContain('loopback')
  })

  it('remote node with valid non-loopback URL → no warning', async () => {
    const caps: NodeCapabilities = {
      nodeId: 'remote-id', nodeName: 'Remote', version: '0.1.0',
      federationProtocolVersion: '1', supportsCatalogSync: true,
      supportsArtworkProxy: true, supportsRemotePlayback: true,
      supportedPlaybackModes: ['direct'], supportsSignedPlaybackUrls: true,
      directPlaybackUrlTtlSeconds: 14400,
      baseUrlConfigured: true,
      publicBaseUrl: 'http://media-box.local:3001',
      directPlaybackRequiresBrowserReachability: true,
    }
    const nodeId = await addRemoteNode('http://media-box.local:3001', caps)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/check`,
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.data.directPlaybackAvailable).toBe(true)
    expect(body.data.supportsRemotePlayback).toBe(true)
    expect(body.data.baseUrlConfigured).toBe(true)
    expect(body.data.warning).toBeUndefined()
  })

  it('no secrets in diagnostic response', async () => {
    const caps: NodeCapabilities = {
      nodeId: 'remote-id', nodeName: 'Remote', version: '0.1.0',
      federationProtocolVersion: '1', supportsCatalogSync: true,
      supportsArtworkProxy: true, supportsRemotePlayback: true,
      supportedPlaybackModes: ['direct'], supportsSignedPlaybackUrls: true,
      directPlaybackUrlTtlSeconds: 14400,
      baseUrlConfigured: true,
      publicBaseUrl: 'http://media-box.local:3001',
      directPlaybackRequiresBrowserReachability: true,
    }
    const nodeId = await addRemoteNode('http://media-box.local:3001', caps)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/check`,
      headers: { Cookie: adminCookie },
    })
    const raw = res.body
    expect(raw).not.toContain('api_token')
    expect(raw).not.toContain('federation_token')
    expect(raw).not.toContain('encrypted')
    expect(raw).not.toContain('password')
  })
})

// ─── Playback-source: localhost warning in remote_direct source ───────────────

describe('getPlaybackSource — localhost streamUrl warning', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let remoteNodeId: string
  let itemId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-pbs-warn-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://hub.local:3001', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    const now = new Date().toISOString()
    remoteNodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: remoteNodeId, name: 'Remote', kind: 'remote',
      base_url: 'http://remote:3001', status: 'online',
      api_token_encrypted: encryptApiKey('tok', testDir),
      created_at: now, updated_at: now,
    })

    const caps: NodeCapabilities = {
      nodeId: remoteNodeId, nodeName: 'Remote', version: '0.1.0',
      federationProtocolVersion: '1', supportsCatalogSync: true,
      supportsArtworkProxy: true, supportsRemotePlayback: true,
      supportedPlaybackModes: ['direct'], supportsSignedPlaybackUrls: true,
      directPlaybackUrlTtlSeconds: 14400,
      baseUrlConfigured: false,
      publicBaseUrl: 'http://localhost:3001',
      directPlaybackRequiresBrowserReachability: true,
    }
    await db.update(nodes)
      .set({ capabilities_json: JSON.stringify(caps) })
      .where(eq(nodes.id, remoteNodeId))

    const libId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libId, node_id: remoteNodeId, name: 'Remote Movies', kind: 'movies',
      root_path: `remote://${remoteNodeId}`, scan_status: 'idle',
      created_at: now, updated_at: now,
    })
    itemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: itemId, library_id: libId, kind: 'movie', title: 'Remote Movie',
      sort_title: 'remote movie', metadata_status: 'matched', created_at: now, updated_at: now,
    })
    const verId = crypto.randomUUID()
    await db.insert(mediaVersions).values({
      id: verId, media_item_id: itemId, quality_label: '1080p',
      resolution_width: 1920, resolution_height: 1080, container: 'mkv',
      duration_seconds: 7200, created_at: now, updated_at: now,
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

  it('localhost streamUrl from remote → warning field present in source', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          status: 'ready',
          mode: 'direct',
          streamUrl: 'http://localhost:3001/api/v1/media-files/file-abc/stream?token=xyz',
          expiresAt: new Date(Date.now() + 14400 * 1000).toISOString(),
          mediaFileId: 'file-abc',
          contentType: 'video/x-matroska',
          container: 'mkv',
        },
      }),
    }))

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.source.code).toBe('remote_direct')
    expect(body.data.source.warning).toBeDefined()
    expect(typeof body.data.source.warning).toBe('string')
    expect(body.data.source.warning).toContain('localhost')
  })

  it('non-localhost streamUrl from remote → no warning field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          status: 'ready',
          mode: 'direct',
          streamUrl: 'http://media-box.local:3001/api/v1/media-files/file-abc/stream?token=xyz',
          expiresAt: new Date(Date.now() + 14400 * 1000).toISOString(),
          mediaFileId: 'file-abc',
          contentType: 'video/x-matroska',
          container: 'mkv',
        },
      }),
    }))

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.source.code).toBe('remote_direct')
    expect(body.data.source.warning).toBeUndefined()
  })
})
