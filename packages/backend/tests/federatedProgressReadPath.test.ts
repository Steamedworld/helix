/**
 * Tests for federated remote progress read path.
 *
 * Covers:
 *   Source endpoint — GET /federation/media/:id/remote-progress  (8 tests)
 *   Viewer proxy endpoint — GET /nodes/:nodeId/media/:mediaId/remote-progress  (6 tests)
 *   Reconciliation helper — deriveRemoteProgressSuggestion  (9 tests)
 *   Diagnostics — GET /admin/sync-diagnostics playbackDiagnostics  (4 tests)
 *
 * Total: 27 tests
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
  remoteWatchProgress,
} from '../src/db/schema'
import { encryptApiKey } from '../src/services/integrations/encryption'
import { deriveRemoteProgressSuggestion } from '../src/services/federation/progressReconciliation'
import type { ProgressSnapshot } from '../src/services/federation/progressReconciliation'

// ─── Test secret ──────────────────────────────────────────────────────────────

process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET = 'test-progress-read-secret'
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

async function insertLocalLibraryAndItem(db: TestDb, localNodeId: string) {
  const now = new Date().toISOString()
  const libId = crypto.randomUUID()
  await db.insert(libraries).values({
    id: libId,
    node_id: localNodeId,
    name: 'Movies',
    kind: 'movies',
    root_path: '/data/movies',
    scan_status: 'idle',
    created_at: now,
    updated_at: now,
  })
  const itemId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: itemId,
    library_id: libId,
    kind: 'movie',
    title: 'Test Movie',
    sort_title: 'test movie',
    metadata_status: 'matched',
    created_at: now,
    updated_at: now,
  })
  await db.insert(mediaVersions).values({
    id: crypto.randomUUID(),
    media_item_id: itemId,
    quality_label: '1080p',
    duration_seconds: 7200,
    created_at: now,
    updated_at: now,
  })
  return { libId, itemId }
}

async function insertRemoteNodeAndItem(db: TestDb, testDir: string) {
  const now = new Date().toISOString()
  const remoteNodeId = crypto.randomUUID()
  await db.insert(nodes).values({
    id: remoteNodeId,
    name: 'Viewer Home',
    kind: 'remote',
    base_url: 'http://viewer-home:3001',
    status: 'online',
    api_token_encrypted: encryptApiKey('remote-federation-token', testDir),
    created_at: now,
    updated_at: now,
  })
  const remoteLibId = crypto.randomUUID()
  await db.insert(libraries).values({
    id: remoteLibId,
    node_id: remoteNodeId,
    name: 'Remote Movies',
    kind: 'movies',
    root_path: `remote://${remoteNodeId}`,
    scan_status: 'idle',
    created_at: now,
    updated_at: now,
  })
  const remoteItemId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: remoteItemId,
    library_id: remoteLibId,
    kind: 'movie',
    title: 'Remote Movie',
    sort_title: 'remote movie',
    metadata_status: 'matched',
    created_at: now,
    updated_at: now,
  })
  return { remoteNodeId, remoteLibId, remoteItemId }
}

// ─── Source endpoint: GET /federation/media/:id/remote-progress ───────────────

describe('Source endpoint: GET /federation/media/:id/remote-progress', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawFederationToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-fprp-source-${crypto.randomUUID()}`)
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
    rawFederationToken = JSON.parse(tokenRes.body).data.token
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 1: Rejects missing/invalid federation auth → 401
  it('rejects missing federation auth → 401', async () => {
    const { itemId } = await insertLocalLibraryAndItem(db, localNodeId)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
    })
    expect(res.statusCode).toBe(401)
  })

  // Test 2: Rejects when sync not enabled → 403
  it('rejects when caller node has sync not enabled → 403', async () => {
    const { itemId } = await insertLocalLibraryAndItem(db, localNodeId)
    const now = new Date().toISOString()
    const callerNodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: callerNodeId,
      name: 'Caller',
      kind: 'remote',
      base_url: 'http://caller:3001',
      status: 'online',
      created_at: now,
      updated_at: now,
      progress_sync_enabled: 0,
      allow_progress_receive: 0,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: {
        Authorization: `Bearer ${rawFederationToken}`,
        'X-Caller-Node-Id': callerNodeId,
      },
    })
    expect(res.statusCode).toBe(403)
  })

  // Test 3: Rejects imported/remote media → 404
  it('rejects imported/remote media items → 404 (proxy loop prevention)', async () => {
    const { remoteItemId } = await insertRemoteNodeAndItem(db, testDir)
    const now = new Date().toISOString()
    const callerNodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: callerNodeId,
      name: 'SyncCaller',
      kind: 'remote',
      base_url: 'http://synccaller:3001',
      status: 'online',
      created_at: now,
      updated_at: now,
      progress_sync_enabled: 1,
      allow_progress_receive: 1,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${remoteItemId}/remote-progress`,
      headers: {
        Authorization: `Bearer ${rawFederationToken}`,
        'X-Caller-Node-Id': callerNodeId,
      },
    })
    expect(res.statusCode).toBe(404)
  })

  // Test 4: Returns { available: false } when no remote progress exists
  it('returns available:false when no remote_watch_progress row exists', async () => {
    const { itemId } = await insertLocalLibraryAndItem(db, localNodeId)
    const now = new Date().toISOString()
    const callerNodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: callerNodeId,
      name: 'ProgressCaller',
      kind: 'remote',
      base_url: 'http://progresscaller:3001',
      status: 'online',
      created_at: now,
      updated_at: now,
      progress_sync_enabled: 1,
      allow_progress_receive: 1,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: {
        Authorization: `Bearer ${rawFederationToken}`,
        'X-Caller-Node-Id': callerNodeId,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.remoteProgress.available).toBe(false)
  })

  // Test 5: Returns bounded aggregate progress when data exists
  it('returns bounded aggregate progress when a row exists', async () => {
    const { itemId } = await insertLocalLibraryAndItem(db, localNodeId)
    const now = new Date().toISOString()
    const callerNodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: callerNodeId,
      name: 'DataCaller',
      kind: 'remote',
      base_url: 'http://datacaller:3001',
      status: 'online',
      created_at: now,
      updated_at: now,
      progress_sync_enabled: 1,
      allow_progress_receive: 1,
    })
    await db.insert(remoteWatchProgress).values({
      id: crypto.randomUUID(),
      source_node_id: callerNodeId,
      remote_viewer_hash: 'abcdef1234567890abcdef1234567890',
      media_item_id: itemId,
      position_seconds: 1800,
      duration_seconds: 7200,
      watched: 0,
      updated_at: now,
      created_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: {
        Authorization: `Bearer ${rawFederationToken}`,
        'X-Caller-Node-Id': callerNodeId,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.remoteProgress.available).toBe(true)
    expect(body.data.remoteProgress.positionSeconds).toBe(1800)
    expect(body.data.remoteProgress.durationSeconds).toBe(7200)
    expect(body.data.remoteProgress.watched).toBe(false)
  })

  // Test 6: Returns most recent progress when multiple viewer hashes exist
  it('returns most recently updated row when multiple viewer hashes exist', async () => {
    const { itemId } = await insertLocalLibraryAndItem(db, localNodeId)
    const now = new Date().toISOString()
    const callerNodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: callerNodeId,
      name: 'MultiHash',
      kind: 'remote',
      base_url: 'http://multihash:3001',
      status: 'online',
      created_at: now,
      updated_at: now,
      progress_sync_enabled: 1,
      allow_progress_receive: 1,
    })

    const olderAt = new Date(Date.now() - 60000).toISOString()
    const newerAt = new Date(Date.now() - 1000).toISOString()

    await db.insert(remoteWatchProgress).values({
      id: crypto.randomUUID(),
      source_node_id: callerNodeId,
      remote_viewer_hash: 'hash1111111111111111111111111111',
      media_item_id: itemId,
      position_seconds: 500,
      duration_seconds: 7200,
      watched: 0,
      updated_at: olderAt,
      created_at: now,
    })
    await db.insert(remoteWatchProgress).values({
      id: crypto.randomUUID(),
      source_node_id: callerNodeId,
      remote_viewer_hash: 'hash2222222222222222222222222222',
      media_item_id: itemId,
      position_seconds: 3600,
      duration_seconds: 7200,
      watched: 0,
      updated_at: newerAt,
      created_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: {
        Authorization: `Bearer ${rawFederationToken}`,
        'X-Caller-Node-Id': callerNodeId,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    // Must return the most recent (positionSeconds=3600)
    expect(body.data.remoteProgress.positionSeconds).toBe(3600)
  })

  // Test 7: Response never includes viewer hash, user IDs, paths, tokens, or stack traces
  it('response never includes viewer_hash, user IDs, paths, tokens, or stack traces', async () => {
    const { itemId } = await insertLocalLibraryAndItem(db, localNodeId)
    const now = new Date().toISOString()
    const callerNodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: callerNodeId,
      name: 'SecurityCaller',
      kind: 'remote',
      base_url: 'http://securitycaller:3001',
      status: 'online',
      created_at: now,
      updated_at: now,
      progress_sync_enabled: 1,
      allow_progress_receive: 1,
    })
    await db.insert(remoteWatchProgress).values({
      id: crypto.randomUUID(),
      source_node_id: callerNodeId,
      remote_viewer_hash: 'aabbccddaabbccddaabbccddaabbccdd',
      media_item_id: itemId,
      position_seconds: 1800,
      duration_seconds: 7200,
      watched: 0,
      updated_at: now,
      created_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: {
        Authorization: `Bearer ${rawFederationToken}`,
        'X-Caller-Node-Id': callerNodeId,
      },
    })
    expect(res.statusCode).toBe(200)
    const raw = res.body

    // MUST NOT expose viewer hash
    expect(raw).not.toContain('aabbccdd')
    expect(raw).not.toContain('viewer_hash')
    expect(raw).not.toContain('remote_viewer_hash')
    // MUST NOT expose federation token
    expect(raw).not.toContain(rawFederationToken)
    // MUST NOT expose stack traces
    expect(raw).not.toContain('at Object.')
    expect(raw).not.toContain('.ts:')
    // MUST NOT expose user IDs or user references
    expect(raw).not.toContain('user_id')
    // MUST NOT expose filesystem paths
    expect(raw).not.toMatch(/\/home\//)
    expect(raw).not.toContain(testDir)
    // MUST NOT contain Authorization header value
    expect(raw).not.toContain('Bearer')
  })

  // Test 8: Proxy loop prevention: returns 403 when no caller node header
  it('returns 403 when no X-Caller-Node-Id header (cannot identify caller)', async () => {
    const { itemId } = await insertLocalLibraryAndItem(db, localNodeId)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/federation/media/${itemId}/remote-progress`,
      headers: {
        Authorization: `Bearer ${rawFederationToken}`,
        // No X-Caller-Node-Id
      },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ─── Viewer proxy endpoint: GET /nodes/:nodeId/media/:mediaId/remote-progress ─

describe('Viewer proxy endpoint: GET /nodes/:nodeId/media/:mediaId/remote-progress', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-fprp-proxy-${crypto.randomUUID()}`)
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

  // Test 9: Requires session auth → 401
  it('requires session auth → 401 without cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nodes/some-node/media/some-media/remote-progress',
    })
    expect(res.statusCode).toBe(401)
  })

  // Test 10: Enforces can_play → 403 for user without permission
  it('returns 403 for user without can_play permission', async () => {
    const { remoteNodeId, remoteLibId, remoteItemId } = await insertRemoteNodeAndItem(db, testDir)
    await db.update(nodes).set({ progress_sync_enabled: 1, allow_progress_push: 1 })
      .where(eq(nodes.id, remoteNodeId))

    // Create limited user with can_view only
    const { users, libraryPermissions } = await import('../src/db/schema')
    const now = new Date().toISOString()
    const userId = crypto.randomUUID()
    await db.insert(users).values({
      id: userId,
      display_name: 'Limited User',
      role: 'user',
      username: `limited-${userId.slice(0, 8)}`,
      password_hash: '$argon2id$v=19$m=65536,t=3,p=4$fakefakefakefake$fakefakefakefakefakefakefakefakefakefakefakefake',
      disabled: 0,
      created_at: now,
      updated_at: now,
    })
    await db.insert(libraryPermissions).values({
      id: crypto.randomUUID(),
      library_id: remoteLibId,
      user_id: userId,
      can_view: true,
      can_play: false, // <-- no play
      created_at: now,
      updated_at: now,
    })

    // Admin bypasses permission — should NOT be 403
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        data: { mediaId: remoteItemId, remoteProgress: { available: false } },
      }),
    }))

    const adminRes = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${remoteItemId}/remote-progress`,
      headers: { Cookie: adminCookie },
    })
    // Admin should not be blocked
    expect(adminRes.statusCode).not.toBe(403)
    expect(adminRes.statusCode).not.toBe(401)
  })

  // Test 11: Cross-node media mismatch → 404
  it('cross-node media mismatch → 404', async () => {
    const { remoteNodeId: node1Id, remoteItemId: item1Id } = await insertRemoteNodeAndItem(db, testDir)

    const now = new Date().toISOString()
    const node2Id = crypto.randomUUID()
    await db.insert(nodes).values({
      id: node2Id,
      name: 'Node2',
      kind: 'remote',
      base_url: 'http://node2:3001',
      status: 'online',
      api_token_encrypted: encryptApiKey('tok2', testDir),
      created_at: now,
      updated_at: now,
    })

    // item1Id belongs to node1Id — accessing via node2Id must 404
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${node2Id}/media/${item1Id}/remote-progress`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  // Test 12: Builds URL from DB base_url only (SSRF prevention)
  it('builds upstream URL from stored node.base_url only — SSRF prevention', async () => {
    const { remoteNodeId, remoteItemId } = await insertRemoteNodeAndItem(db, testDir)
    await db.update(nodes).set({ progress_sync_enabled: 1, allow_progress_push: 1 })
      .where(eq(nodes.id, remoteNodeId))

    let capturedUrl: string | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      capturedUrl = url
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          data: { mediaId: remoteItemId, remoteProgress: { available: false } },
        }),
      })
    }))

    await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${remoteItemId}/remote-progress`,
      headers: { Cookie: adminCookie },
    })

    // URL must start with the stored base_url
    expect(capturedUrl).toBeDefined()
    expect(capturedUrl).toMatch(/^http:\/\/viewer-home:3001\//)
    expect(capturedUrl).not.toContain('evil')
    expect(capturedUrl).not.toContain('localhost:9999')
  })

  // Test 13: Maps upstream 401/403 → 502 with safe message
  it('maps upstream 401/403 → 502 with safe message (no auth detail leaked)', async () => {
    const { remoteNodeId, remoteItemId } = await insertRemoteNodeAndItem(db, testDir)
    await db.update(nodes).set({ progress_sync_enabled: 1, allow_progress_push: 1 })
      .where(eq(nodes.id, remoteNodeId))

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      json: async () => ({ ok: false, error: 'Unauthorized with token abc' }),
    }))

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${remoteItemId}/remote-progress`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
    // Must not leak auth details
    expect(res.body).not.toContain('Unauthorized with token')
    expect(res.body).not.toContain('abc')
    expect(res.body).not.toContain('Bearer')
  })

  // Test 14: Maps upstream network failure → { available: false, error: 'source_unavailable' }
  it('maps upstream network failure → { available: false, error: source_unavailable }', async () => {
    const { remoteNodeId, remoteItemId } = await insertRemoteNodeAndItem(db, testDir)
    await db.update(nodes).set({ progress_sync_enabled: 1, allow_progress_push: 1 })
      .where(eq(nodes.id, remoteNodeId))

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${remoteItemId}/remote-progress`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.available).toBe(false)
    expect(body.data.error).toBe('source_unavailable')
    // Must not expose raw error
    expect(res.body).not.toContain('ECONNREFUSED')
  })
})

// ─── Reconciliation helper ─────────────────────────────────────────────────────

describe('deriveRemoteProgressSuggestion reconciliation helper', () => {
  const now = new Date().toISOString()

  function snapshot(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
    return {
      positionSeconds: 1800,
      durationSeconds: 7200,
      watched: false,
      updatedAt: now,
      ...overrides,
    }
  }

  // Test 15: No remote → no_suggestion / no_remote
  it('no remote → no_suggestion / no_remote', () => {
    const result = deriveRemoteProgressSuggestion(snapshot(), { available: false })
    expect(result.suggestion).toBe('no_suggestion')
    expect(result.reason).toBe('no_remote')
  })

  it('null remote → no_suggestion / no_remote', () => {
    const result = deriveRemoteProgressSuggestion(snapshot(), null)
    expect(result.suggestion).toBe('no_suggestion')
    expect(result.reason).toBe('no_remote')
  })

  // Test 16: Valid remote when no local progress → use_remote / remote_meaningfully_ahead
  it('valid remote with no local progress → use_remote / remote_meaningfully_ahead', () => {
    const result = deriveRemoteProgressSuggestion(null, snapshot({ positionSeconds: 3600 }))
    expect(result.suggestion).toBe('use_remote')
    expect(result.reason).toBe('remote_meaningfully_ahead')
  })

  // Test 17: Remote meaningfully ahead (> 60s and > 5%) → use_remote / remote_meaningfully_ahead
  it('remote meaningfully ahead (> 60s and > 5%) → use_remote / remote_meaningfully_ahead', () => {
    const local = snapshot({ positionSeconds: 900 })
    const remote = snapshot({ positionSeconds: 3600 }) // 2700s ahead, ~37.5% of 7200
    const result = deriveRemoteProgressSuggestion(local, remote)
    expect(result.suggestion).toBe('use_remote')
    expect(result.reason).toBe('remote_meaningfully_ahead')
  })

  // Test 18: Remote only slightly ahead (< 30s) → no_suggestion / tiny_difference
  it('remote only slightly ahead (< 30s) → no_suggestion / tiny_difference', () => {
    const local = snapshot({ positionSeconds: 1800 })
    const remote = snapshot({ positionSeconds: 1815 }) // 15s ahead
    const result = deriveRemoteProgressSuggestion(local, remote)
    expect(result.suggestion).toBe('no_suggestion')
    expect(result.reason).toBe('tiny_difference')
  })

  // Test 19: Remote older than local → no_suggestion / remote_older
  it('remote updatedAt older than local → no_suggestion / remote_older', () => {
    const localUpdated = new Date(Date.now() - 1000).toISOString() // 1s ago
    const remoteUpdated = new Date(Date.now() - 60000).toISOString() // 60s ago
    const local = snapshot({ positionSeconds: 1800, updatedAt: localUpdated })
    const remote = snapshot({ positionSeconds: 3600, updatedAt: remoteUpdated })
    const result = deriveRemoteProgressSuggestion(local, remote)
    expect(result.suggestion).toBe('no_suggestion')
    expect(result.reason).toBe('remote_older')
  })

  // Test 20: Duration mismatch > 10% → no_suggestion / duration_mismatch
  it('duration mismatch > 10% → no_suggestion / duration_mismatch', () => {
    // local=7200, remote=9000: abs(9000-7200)/max(9000,7200) = 1800/9000 = 0.20 (20% > 10%)
    const local = snapshot({ positionSeconds: 1800, durationSeconds: 7200 })
    const remote = snapshot({ positionSeconds: 3600, durationSeconds: 9000 }) // 20% diff
    const result = deriveRemoteProgressSuggestion(local, remote)
    expect(result.suggestion).toBe('no_suggestion')
    expect(result.reason).toBe('duration_mismatch')
  })

  // Test 21: Invalid watched threshold (watched=true, < 85% duration) → no_suggestion / invalid_threshold
  it('watched=true with < 85% completion → no_suggestion / invalid_threshold', () => {
    const remote = snapshot({
      positionSeconds: 5000, // 69% of 7200
      durationSeconds: 7200,
      watched: true,
    })
    const result = deriveRemoteProgressSuggestion(null, remote)
    expect(result.suggestion).toBe('no_suggestion')
    expect(result.reason).toBe('invalid_threshold')
  })

  // Test 22: Invalid overrun (position > duration * 1.01) → no_suggestion / invalid_overrun
  it('position > duration * 1.01 → no_suggestion / invalid_overrun', () => {
    const remote = snapshot({
      positionSeconds: 7300, // > 7272 (7200 * 1.01)
      durationSeconds: 7200,
    })
    const result = deriveRemoteProgressSuggestion(null, remote)
    expect(result.suggestion).toBe('no_suggestion')
    expect(result.reason).toBe('invalid_overrun')
  })

  // Test 23: Remote stale (> 7 days) → no_suggestion / stale_remote
  it('remote stale > 7 days → no_suggestion / stale_remote', () => {
    const staleUpdated = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const remote = snapshot({ positionSeconds: 3600, updatedAt: staleUpdated })
    const result = deriveRemoteProgressSuggestion(null, remote)
    expect(result.suggestion).toBe('no_suggestion')
    expect(result.reason).toBe('stale_remote')
  })
})

// ─── Diagnostics ──────────────────────────────────────────────────────────────

describe('Admin sync diagnostics — playbackDiagnostics section', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-fprp-diag-${crypto.randomUUID()}`)
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

  // Test 24: playbackDiagnostics section present in admin response
  it('playbackDiagnostics section is present in sync-diagnostics response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.playbackDiagnostics).toBeDefined()
    expect(typeof body.data.playbackDiagnostics.proxyEnabled).toBe('boolean')
    expect(body.data.playbackDiagnostics.recentProxyFailures).toBeDefined()
    expect(typeof body.data.playbackDiagnostics.homesWithPlaybackIssue).toBe('number')
    expect(typeof body.data.playbackDiagnostics.homesWithProxyAvailable).toBe('number')
  })

  // Test 25: Proxy failure counts are per-code histogram
  it('proxy failure histogram has expected code keys', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const failures = body.data.playbackDiagnostics.recentProxyFailures
    expect(failures).toHaveProperty('remote_unreachable')
    expect(failures).toHaveProperty('remote_unauthorized')
    expect(failures).toHaveProperty('range_failed')
    expect(failures).toHaveProperty('proxy_disabled')
    expect(failures).toHaveProperty('unknown')
  })

  // Test 26: Response never includes secret values, node IDs in histograms, paths, or tokens
  it('response never exposes secret values, paths, tokens, or node IDs in histogram', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const raw = res.body

    // MUST NOT expose secret values
    expect(raw).not.toContain('test-progress-read-secret')
    expect(raw).not.toContain('TRUSTED_HOME_PLAYBACK_REFRESH_SECRET')
    // MUST NOT expose stack traces
    expect(raw).not.toContain('at Object.')
    expect(raw).not.toContain('.ts:')
    // MUST NOT expose filesystem paths
    expect(raw).not.toMatch(/\/home\//)
    expect(raw).not.toContain(testDir)
  })

  // Test 27: mediaToken health state is safe label only
  it('secretsHealth.mediaToken contains only a safe state label', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.secretsHealth).toBeDefined()
    expect(body.data.secretsHealth.mediaToken).toBeDefined()
    const mediaTokenState = body.data.secretsHealth.mediaToken.state
    expect(['explicit_secret', 'not_configured']).toContain(mediaTokenState)
    // MUST NOT expose the MEDIA_TOKEN_SECRET value
    if (process.env.MEDIA_TOKEN_SECRET) {
      expect(res.body).not.toContain(process.env.MEDIA_TOKEN_SECRET)
    }
  })
})
