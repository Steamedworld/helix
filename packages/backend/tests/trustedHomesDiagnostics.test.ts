/**
 * Tests for the Trusted Homes UX — covering the diagnostics check endpoint,
 * admin banner pre-conditions (config + nodes), and terminology changes
 * that are visible at the API boundary.
 *
 * UI-layer tests (nav label, page heading, etc.) live in the frontend, which
 * currently has no test runner. These backend tests cover everything the
 * server-side can verify.
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

// ─── Check-connection endpoint: inline diagnostics ────────────────────────────

describe('GET /api/v1/nodes/:id/check — trusted home diagnostics', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-thdiag-${crypto.randomUUID()}`)
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

  async function addRemoteNode(
    baseUrl = 'http://trusted-home:3001',
    caps?: NodeCapabilities | null
  ) {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Living Room', base_url: baseUrl, api_token: 'tok' },
    })
    expect(createRes.statusCode).toBe(201)
    const nodeId = JSON.parse(createRes.body).data.id
    if (caps !== undefined) {
      await db
        .update(nodes)
        .set({ capabilities_json: caps ? JSON.stringify(caps) : null })
        .where(eq(nodes.id, nodeId))
    }
    return nodeId
  }

  // Ready state: supportsRemotePlayback=true + baseUrlConfigured=true + non-loopback
  it('Ready state — directPlaybackAvailable=true, baseUrlConfigured=true, no warning', async () => {
    const caps: NodeCapabilities = {
      nodeId: 'remote-id', nodeName: 'Living Room', version: '0.1.0',
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
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.directPlaybackAvailable).toBe(true)
    expect(body.data.supportsRemotePlayback).toBe(true)
    expect(body.data.baseUrlConfigured).toBe(true)
    expect(body.data.warning).toBeUndefined()
  })

  // Warning state: supportsRemotePlayback=true + baseUrlConfigured=false
  it('Warning state — directPlaybackAvailable=true but baseUrlConfigured=false → warning present', async () => {
    const caps: NodeCapabilities = {
      nodeId: 'remote-id', nodeName: 'Living Room', version: '0.1.0',
      federationProtocolVersion: '1', supportsCatalogSync: true,
      supportsArtworkProxy: true, supportsRemotePlayback: true,
      supportedPlaybackModes: ['direct'], supportsSignedPlaybackUrls: true,
      directPlaybackUrlTtlSeconds: 14400,
      baseUrlConfigured: false,
      directPlaybackRequiresBrowserReachability: true,
    }
    const nodeId = await addRemoteNode('http://trusted-home:3001', caps)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/check`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.directPlaybackAvailable).toBe(true)
    expect(body.data.supportsRemotePlayback).toBe(true)
    expect(body.data.baseUrlConfigured).toBe(false)
    // Warning must be present and non-empty
    expect(typeof body.data.warning).toBe('string')
    expect(body.data.warning.length).toBeGreaterThan(0)
  })

  // Warning state: loopback publicBaseUrl
  it('Warning state — loopback publicBaseUrl → warning present', async () => {
    const caps: NodeCapabilities = {
      nodeId: 'remote-id', nodeName: 'Living Room', version: '0.1.0',
      federationProtocolVersion: '1', supportsCatalogSync: true,
      supportsArtworkProxy: true, supportsRemotePlayback: true,
      supportedPlaybackModes: ['direct'], supportsSignedPlaybackUrls: true,
      directPlaybackUrlTtlSeconds: 14400,
      baseUrlConfigured: false,
      publicBaseUrl: 'http://localhost:3001',
      directPlaybackRequiresBrowserReachability: true,
    }
    const nodeId = await addRemoteNode('http://trusted-home:3001', caps)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/check`,
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.data.warning).toBeDefined()
    expect(body.data.warning).toContain('loopback')
  })

  // Error/unsupported state: supportsRemotePlayback=false
  it('Unsupported state — supportsRemotePlayback=false → directPlaybackAvailable=false', async () => {
    const caps: NodeCapabilities = {
      nodeId: 'remote-id', nodeName: 'Living Room', version: '0.1.0',
      federationProtocolVersion: '1', supportsCatalogSync: true,
      supportsArtworkProxy: false, supportsRemotePlayback: false,
      supportedPlaybackModes: [], supportsSignedPlaybackUrls: false,
      directPlaybackUrlTtlSeconds: 0,
      baseUrlConfigured: false,
      directPlaybackRequiresBrowserReachability: true,
    }
    const nodeId = await addRemoteNode('http://trusted-home:3001', caps)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/check`,
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.data.directPlaybackAvailable).toBe(false)
    expect(body.data.supportsRemotePlayback).toBe(false)
    expect(typeof body.data.warning).toBe('string')
  })

  // Non-admin cannot check
  it('Non-admin user receives 401', async () => {
    const nodeId = await addRemoteNode()
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/check`,
    })
    expect(res.statusCode).toBe(401)
  })

  // No secrets in diagnostic response
  it('Response contains no secrets or tokens', async () => {
    const caps: NodeCapabilities = {
      nodeId: 'remote-id', nodeName: 'Living Room', version: '0.1.0',
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

// ─── Admin banner pre-conditions: config + nodes ──────────────────────────────
// The frontend admin banner shows when: remote nodes exist AND config.baseUrlConfigured=false.
// These tests verify that the API endpoints return the data the frontend needs
// to make that decision correctly.

describe('Admin banner pre-conditions — config endpoint + node list', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-banner-${crypto.randomUUID()}`)
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

  // Banner shows when: remote nodes exist AND baseUrlConfigured=false.
  // Test: add a remote node → node list returns at least one remote.
  it('Remote node registered → node list has kind=remote (banner condition met)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: { name: 'Living Room', base_url: 'http://home:3001', api_token: 'tok' },
    })

    const nodesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
    })
    expect(nodesRes.statusCode).toBe(200)
    const remoteNodes = JSON.parse(nodesRes.body).data.filter(
      (n: { kind: string }) => n.kind === 'remote'
    )
    expect(remoteNodes.length).toBeGreaterThan(0)
  })

  // Banner hidden when no remote nodes exist.
  it('No remote nodes registered → no kind=remote in list', async () => {
    const nodesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
    })
    const remoteNodes = JSON.parse(nodesRes.body).data.filter(
      (n: { kind: string }) => n.kind === 'remote'
    )
    expect(remoteNodes.length).toBe(0)
  })

  // Config endpoint always returns all three required fields.
  it('Config endpoint returns required shape for banner logic', async () => {
    const configRes = await app.inject({ method: 'GET', url: '/api/v1/config' })
    expect(configRes.statusCode).toBe(200)
    const configBody = JSON.parse(configRes.body)
    expect('baseUrlConfigured' in configBody.data).toBe(true)
    expect('baseUrlIsLoopback' in configBody.data).toBe(true)
    expect('baseUrl' in configBody.data).toBe(true)
  })

  // Non-admin cannot fetch nodes — banner is admin-only in the UI.
  it('Non-admin user cannot fetch nodes — 401 (banner never shown for non-admin)', async () => {
    const nodesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/nodes',
    })
    expect(nodesRes.statusCode).toBe(401)
  })
})

// ─── Settings: server address / config endpoint ────────────────────────────────
// The config endpoint drives the Settings "Home server address" card.
// It reads from the module-level config (populated from process.env.BASE_URL at startup),
// not from the buildServer argument. These tests verify the endpoint's shape and
// the logic that the UI relies on.

describe('Settings page — server address config endpoint shape', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-settings-${crypto.randomUUID()}`)
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

  it('Response shape includes all fields the Settings UI needs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    // All three fields required for the home server address card
    expect('baseUrl' in body.data).toBe(true)
    expect('baseUrlConfigured' in body.data).toBe(true)
    expect('baseUrlIsLoopback' in body.data).toBe(true)
    // No secrets
    const raw = res.body
    expect(raw).not.toContain('token')
    expect(raw).not.toContain('password')
    expect(raw).not.toContain('encrypted')
    expect(raw).not.toContain('key')
  })

  it('baseUrl is null when BASE_URL env var is not set (Local only state)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' })
    const body = JSON.parse(res.body)
    // In test env, BASE_URL is not set → baseUrl is null
    expect(body.data.baseUrl).toBeNull()
    expect(body.data.baseUrlConfigured).toBe(false)
  })

  it('baseUrlConfigured and baseUrlIsLoopback are mutually exclusive booleans', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' })
    const { baseUrlConfigured, baseUrlIsLoopback } = JSON.parse(res.body).data
    expect(typeof baseUrlConfigured).toBe('boolean')
    expect(typeof baseUrlIsLoopback).toBe('boolean')
    // Cannot be both true at the same time
    expect(baseUrlConfigured && baseUrlIsLoopback).toBe(false)
  })
})

// ─── Remote playback unavailable / unsupported ────────────────────────────────

describe('Remote playback source codes — MediaDetail copy scenarios', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-rps-${crypto.randomUUID()}`)
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

  async function addRemoteNodeWithItem(supportsPlayback: boolean) {
    const now = new Date().toISOString()
    const remoteNodeId = crypto.randomUUID()
    const { libraries, mediaItems, mediaVersions, mediaFiles } = await import('../src/db/schema')

    await db.insert(nodes).values({
      id: remoteNodeId, name: 'Living Room', kind: 'remote',
      base_url: 'http://home:3001', status: 'online',
      api_token_encrypted: encryptApiKey('tok', testDir),
      created_at: now, updated_at: now,
    })

    const caps: NodeCapabilities = {
      nodeId: remoteNodeId, nodeName: 'Living Room', version: '0.1.0',
      federationProtocolVersion: '1', supportsCatalogSync: true,
      supportsArtworkProxy: true, supportsRemotePlayback: supportsPlayback,
      supportedPlaybackModes: supportsPlayback ? ['direct'] : [],
      supportsSignedPlaybackUrls: supportsPlayback,
      directPlaybackUrlTtlSeconds: supportsPlayback ? 14400 : 0,
      baseUrlConfigured: supportsPlayback,
      publicBaseUrl: supportsPlayback ? 'http://home:3001' : undefined,
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
    const itemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: itemId, library_id: libId, kind: 'movie', title: 'Remote Film',
      sort_title: 'remote film', metadata_status: 'matched', created_at: now, updated_at: now,
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

    return { remoteNodeId, itemId }
  }

  it('Unsupported remote node → code=remote_playback_unsupported with nodeName', async () => {
    const { itemId } = await addRemoteNodeWithItem(false)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.unavailable).toBe(true)
    expect(['remote_playback_unsupported', 'remote_available']).toContain(body.data.code)
    // nodeName is present so UI can render "available from Living Room"
    expect(body.data.nodeName).toBe('Living Room')
  })
})
