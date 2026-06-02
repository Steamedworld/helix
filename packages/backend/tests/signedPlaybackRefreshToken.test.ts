/**
 * Tests for Signed Playback Refresh Tokens.
 *
 * Covers:
 *   Token signing module    — unit tests for sign/verify  (4 tests)
 *   Refresh endpoint (?rt)  — token-auth path             (10 tests)
 *   Security assertions     — nothing leaks               (5 tests)
 *   Regression              — session-auth path, capabilities, directStreamUrl  (3 tests)
 *
 * Total: 22 tests
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
import {
  nodes,
  libraries,
  mediaItems,
  mediaVersions,
  mediaFiles,
  libraryPermissions,
  users,
} from '../src/db/schema'
import { encryptApiKey } from '../src/services/integrations/encryption'
import {
  signPlaybackRefreshToken,
  verifyPlaybackRefreshToken,
  deriveSessionBinding,
} from '../src/services/federation/playbackRefreshToken'

// ─── Module-level test secret ─────────────────────────────────────────────────
//
// Set TRUSTED_HOME_PLAYBACK_REFRESH_SECRET so the server and tests share a known key.
// This is set before any imports that read process.env — all within the same test process.
const TEST_REFRESH_SECRET = 'test-refresh-secret-for-signed-tokens-unit-tests'
process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET = TEST_REFRESH_SECRET
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

async function insertRemoteSetup(
  db: TestDb,
  testDir: string,
  opts: { apiToken?: string; baseUrl?: string } = {}
) {
  const now = new Date().toISOString()
  const remoteNodeId = crypto.randomUUID()
  const apiToken = opts.apiToken ?? 'test-fed-token'
  const baseUrl = opts.baseUrl ?? 'http://remote-hub:3001'

  await db.insert(nodes).values({
    id: remoteNodeId,
    name: 'Remote Hub',
    kind: 'remote',
    base_url: baseUrl,
    status: 'online',
    api_token_encrypted: encryptApiKey(apiToken, testDir),
    capabilities_json: JSON.stringify({
      nodeId: remoteNodeId,
      nodeName: 'Remote Hub',
      version: '0.1.0',
      federationProtocolVersion: '1',
      supportsCatalogSync: true,
      supportsArtworkProxy: true,
      supportsRemotePlayback: true,
      supportedPlaybackModes: ['direct'],
      supportsSignedPlaybackUrls: true,
      directPlaybackUrlTtlSeconds: 14400,
      baseUrlConfigured: true,
      directPlaybackRequiresBrowserReachability: true,
    }),
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

  const itemId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: itemId,
    library_id: remoteLibId,
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
    resolution_width: 1920,
    resolution_height: 1080,
    container: 'mkv',
    duration_seconds: 7200,
    created_at: now,
    updated_at: now,
  })
  const fileId = crypto.randomUUID()
  await db.insert(mediaFiles).values({
    id: fileId,
    node_id: remoteNodeId,
    library_id: remoteLibId,
    media_item_id: itemId,
    media_version_id: verId,
    path: `remote://${remoteNodeId}/${fileId}`,
    filename: 'remote.mkv',
    extension: 'mkv',
    size_bytes: 4000000000,
    file_hash: null,
    discovered_at: now,
    updated_at: now,
  })

  return { remoteNodeId, remoteLibId, itemId, verId, fileId }
}

function makeReadyIntent() {
  return {
    status: 'ready',
    mode: 'direct',
    streamUrl: 'http://remote-hub:3001/api/v1/media-files/abc/stream?token=xyz',
    expiresAt: new Date(Date.now() + 14400000).toISOString(),
    mediaFileId: 'abc',
    contentType: 'video/x-matroska',
    container: 'mkv',
  }
}

function mockFetchReadyIntent() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, data: makeReadyIntent() }),
  }))
}

// ─── Token signing unit tests ─────────────────────────────────────────────────

describe('Token signing: signPlaybackRefreshToken / verifyPlaybackRefreshToken', () => {
  // Test 1: sign produces a verifiable token
  it('signPlaybackRefreshToken produces a token verifiable by verifyPlaybackRefreshToken', () => {
    const token = signPlaybackRefreshToken(
      { sub: 'user-1', sid: 'sess-hash-1', nodeId: 'node-1', mediaId: 'media-1' },
      TEST_REFRESH_SECRET,
      600000
    )
    expect(typeof token).toBe('string')
    expect(token).toContain('.') // payloadB64.sigB64

    const result = verifyPlaybackRefreshToken(token, TEST_REFRESH_SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.sub).toBe('user-1')
      expect(result.payload.sid).toBe('sess-hash-1')
      expect(result.payload.nodeId).toBe('node-1')
      expect(result.payload.mediaId).toBe('media-1')
      expect(result.payload.v).toBe(1)
      expect(result.payload.purpose).toBe('playback_refresh')
      expect(typeof result.payload.nonce).toBe('string')
      expect(result.payload.nonce.length).toBe(32) // 16 bytes hex
    }
  })

  // Test 2: verifyPlaybackRefreshToken returns payload for valid token
  it('verifyPlaybackRefreshToken returns ok=true with correct payload for valid token', () => {
    const userId = crypto.randomUUID()
    const nodeId = crypto.randomUUID()
    const mediaId = crypto.randomUUID()
    const sid = deriveSessionBinding('raw-session-token-xyz')

    const token = signPlaybackRefreshToken(
      { sub: userId, sid, nodeId, mediaId },
      TEST_REFRESH_SECRET,
      600000
    )
    const result = verifyPlaybackRefreshToken(token, TEST_REFRESH_SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.sub).toBe(userId)
      expect(result.payload.sid).toBe(sid)
      expect(result.payload.nodeId).toBe(nodeId)
      expect(result.payload.mediaId).toBe(mediaId)
      expect(result.payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
    }
  })

  // Test 3: expired token returns { ok: false, error: 'expired' }
  it('expired token returns ok=false with error="expired"', () => {
    // Sign with -1ms TTL — already expired
    const token = signPlaybackRefreshToken(
      { sub: 'u', sid: 's', nodeId: 'n', mediaId: 'm' },
      TEST_REFRESH_SECRET,
      -1000 // negative TTL → exp in the past
    )
    const result = verifyPlaybackRefreshToken(token, TEST_REFRESH_SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('expired')
    }
  })

  // Test 4: token with corrupted signature returns { ok: false, error: 'tampered' }
  it('corrupted signature returns ok=false with error="tampered"', () => {
    const token = signPlaybackRefreshToken(
      { sub: 'u', sid: 's', nodeId: 'n', mediaId: 'm' },
      TEST_REFRESH_SECRET,
      600000
    )
    // Flip the last character of the signature portion
    const parts = token.split('.')
    const corruptedSig = parts[1].slice(0, -2) + 'XX'
    const corrupted = `${parts[0]}.${corruptedSig}`
    const result = verifyPlaybackRefreshToken(corrupted, TEST_REFRESH_SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('tampered')
    }
  })
})

// ─── Refresh endpoint: token-auth path (?rt=...) ─────────────────────────────

describe('Refresh endpoint (signed token path): GET /nodes/:nodeId/media/:mediaId/playback-source?rt=...', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  // We need the userId of the admin to build a valid token
  let adminUserId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-srt-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://localhost:3001', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    // Extract userId of admin from session
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { Cookie: adminCookie },
    })
    adminUserId = JSON.parse(meRes.body).data.user.id
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  function makeAdminToken(nodeId: string, mediaId: string, opts: {
    sub?: string
    sid?: string
    ttlMs?: number
  } = {}) {
    return signPlaybackRefreshToken(
      {
        sub: opts.sub ?? adminUserId,
        sid: opts.sid ?? deriveSessionBinding('fake-session-token'),
        nodeId,
        mediaId,
      },
      TEST_REFRESH_SECRET,
      opts.ttlMs ?? 600000
    )
  }

  // Test 5: Valid ?rt token returns fresh PlaybackSource with rotated refreshUrl
  it('valid ?rt token returns fresh PlaybackSource with rotated refreshUrl (new nonce)', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)
    mockFetchReadyIntent()

    const rt = makeAdminToken(remoteNodeId, itemId)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source?rt=${rt}`,
      // No session cookie — token-only auth
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    const src = body.data
    expect(src.streamUrl).toContain('/api/v1/nodes/')
    expect(src.streamUrl).toContain(remoteNodeId)
    // refreshUrl must contain a new ?rt= token (rotated)
    expect(src.refreshUrl).toContain('/api/v1/nodes/')
    expect(src.refreshUrl).toContain('playback-source?rt=')
    // The new token must be different (different nonce/iat)
    const oldRt = rt
    const newRt = new URL(`http://x${src.refreshUrl}`).searchParams.get('rt')
    expect(newRt).toBeTruthy()
    expect(newRt).not.toBe(oldRt)
    // New token must be verifiable
    const verifyNew = verifyPlaybackRefreshToken(newRt!, TEST_REFRESH_SECRET)
    expect(verifyNew.ok).toBe(true)
    // Expiry metadata present
    expect(typeof src.expiresAt).toBe('string')
    expect(new Date(src.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  // Test 6: Expired ?rt returns 401
  it('expired ?rt returns 401', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)
    const expiredRt = makeAdminToken(remoteNodeId, itemId, { ttlMs: -1000 })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source?rt=${expiredRt}`,
    })
    expect(res.statusCode).toBe(401)
  })

  // Test 7: Tampered ?rt returns 401
  it('tampered ?rt returns 401', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)
    const token = makeAdminToken(remoteNodeId, itemId)
    // Corrupt the signature
    const parts = token.split('.')
    const corrupted = `${parts[0]}.AAAAAAAAA`

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source?rt=${corrupted}`,
    })
    expect(res.statusCode).toBe(401)
  })

  // Test 8: Token with wrong nodeId returns 401 (scope check)
  it('token with wrong nodeId in payload returns 401 (scope mismatch)', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)
    const wrongNodeToken = makeAdminToken('wrong-node-id-xyz', itemId)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source?rt=${wrongNodeToken}`,
    })
    expect(res.statusCode).toBe(401)
  })

  // Test 9: Token with wrong mediaId returns 401 (scope check)
  it('token with wrong mediaId in payload returns 401 (scope mismatch)', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)
    const wrongMediaToken = makeAdminToken(remoteNodeId, 'wrong-media-id-xyz')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source?rt=${wrongMediaToken}`,
    })
    expect(res.statusCode).toBe(401)
  })

  // Test 10: Token with wrong purpose returns 401
  it('token with wrong purpose (not playback_refresh) returns 401', async () => {
    // Craft a token with wrong purpose by manually building a payload with tampered purpose
    // We sign with the correct secret but wrong purpose — should fail at 'wrong_purpose' check
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)

    // Build a base64url payload with purpose='stream' instead of 'playback_refresh'
    const wrongPurposePayload = {
      v: 1,
      purpose: 'stream', // wrong
      sub: adminUserId,
      sid: deriveSessionBinding('fake'),
      nodeId: remoteNodeId,
      mediaId: itemId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: 'aabbccddeeff00112233445566778899',
    }
    function b64url(s: string) {
      return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    }
    const { createHmac } = await import('crypto')
    const payloadB64 = b64url(JSON.stringify(wrongPurposePayload))
    const sig = createHmac('sha256', TEST_REFRESH_SECRET).update(payloadB64).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const wrongPurposeToken = `${payloadB64}.${sig}`

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source?rt=${wrongPurposeToken}`,
    })
    expect(res.statusCode).toBe(401)
  })

  // Test 11: Token with non-existent userId returns 401 (user resolution fails)
  it('token with non-existent userId returns 401 (user not found)', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)
    const ghostToken = makeAdminToken(remoteNodeId, itemId, { sub: 'nonexistent-user-id' })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source?rt=${ghostToken}`,
    })
    expect(res.statusCode).toBe(401)
  })

  // Test 12: Missing ?rt and missing session → 401
  it('missing ?rt and missing session cookie returns 401', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source`,
      // No cookie, no ?rt
    })
    expect(res.statusCode).toBe(401)
  })

  // Test 13: Cross-node confusion still prevented (mediaId belongs to different node)
  it('cross-node confusion prevented: mediaId that belongs to a different node returns 404', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)

    // Create a second node
    const now = new Date().toISOString()
    const otherNodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: otherNodeId,
      name: 'Other Node',
      kind: 'remote',
      base_url: 'http://other:3001',
      status: 'online',
      api_token_encrypted: encryptApiKey('other-token', testDir),
      created_at: now,
      updated_at: now,
    })

    // Token is correctly scoped to otherNodeId/itemId (scope check passes)
    // but itemId belongs to remoteNodeId, not otherNodeId → 404 on DB lookup
    const rt = makeAdminToken(otherNodeId, itemId)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${otherNodeId}/media/${itemId}/playback-source?rt=${rt}`,
    })
    // 404 because the item does not belong to otherNodeId
    expect(res.statusCode).toBe(404)
  })

  // Test 14: Proxy disabled → 503
  it('proxy disabled (TRUSTED_HOME_PLAYBACK_PROXY_ENABLED=false) returns 503', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)
    const rt = makeAdminToken(remoteNodeId, itemId)

    // Temporarily override config
    const originalEnabled = process.env.TRUSTED_HOME_PLAYBACK_PROXY_ENABLED
    process.env.TRUSTED_HOME_PLAYBACK_PROXY_ENABLED = 'false'

    // Re-build the server with the updated env state by reading config at request time
    // The config object reads from process.env at module load, so we override the runtime value
    const { config } = await import('../src/config')
    const originalValue = config.trustedHomePlaybackProxyEnabled
    ;(config as Record<string, unknown>).trustedHomePlaybackProxyEnabled = false

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source?rt=${rt}`,
    })
    expect(res.statusCode).toBe(503)

    // Restore
    ;(config as Record<string, unknown>).trustedHomePlaybackProxyEnabled = originalValue
    process.env.TRUSTED_HOME_PLAYBACK_PROXY_ENABLED = originalEnabled
  })
})

// ─── Security assertions ──────────────────────────────────────────────────────

describe('Security: refresh response and token payload never leak secrets', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let adminUserId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-srt-sec-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://localhost:3001', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
    const meRes = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { Cookie: adminCookie } })
    adminUserId = JSON.parse(meRes.body).data.user.id
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  // Test 15: Refresh response does not include federation token, Authorization value, or signing secret
  it('refresh response does not include federation token, Authorization value, or signing secret', async () => {
    const apiToken = 'ultra-secret-federation-token'
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir, { apiToken })
    mockFetchReadyIntent()

    const rt = signPlaybackRefreshToken(
      { sub: adminUserId, sid: deriveSessionBinding('fake-sess'), nodeId: remoteNodeId, mediaId: itemId },
      TEST_REFRESH_SECRET, 600000
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source?rt=${rt}`,
    })
    expect(res.statusCode).toBe(200)
    const raw = res.body

    // Federation token must not appear
    expect(raw).not.toContain(apiToken)
    // Signing secret must not appear
    expect(raw).not.toContain(TEST_REFRESH_SECRET)
    // Authorization header value must not appear
    expect(raw).not.toContain('Bearer ')
    expect(raw).not.toContain('api_token')
    expect(raw).not.toContain('encrypted')
  })

  // Test 16: Refresh response does not include filesystem path
  it('refresh response does not include filesystem path', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)
    mockFetchReadyIntent()

    const rt = signPlaybackRefreshToken(
      { sub: adminUserId, sid: deriveSessionBinding('fake'), nodeId: remoteNodeId, mediaId: itemId },
      TEST_REFRESH_SECRET, 600000
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source?rt=${rt}`,
    })
    expect(res.statusCode).toBe(200)
    const raw = res.body
    expect(raw).not.toMatch(/\/home\//)
    expect(raw).not.toMatch(/\/tmp\//)
    expect(raw).not.toContain(testDir)
    expect(raw).not.toContain('remote://')
  })

  // Test 17: Refresh response does not include upstream node URL in a dangerous field
  it('refresh response does not include raw upstream node base_url as a leaked field', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          status: 'ready',
          mode: 'direct',
          // The streamUrl from the remote — if node base_url is private, directStreamUrl omitted
          streamUrl: 'http://remote-hub:3001/api/v1/media-files/abc/stream?token=xyz',
          expiresAt: new Date(Date.now() + 14400000).toISOString(),
          mediaFileId: 'abc',
          contentType: 'video/x-matroska',
          container: 'mkv',
        },
      }),
    }))

    const rt = signPlaybackRefreshToken(
      { sub: adminUserId, sid: deriveSessionBinding('fake'), nodeId: remoteNodeId, mediaId: itemId },
      TEST_REFRESH_SECRET, 600000
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source?rt=${rt}`,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const src = body.data

    // proxyStreamUrl is correct local path
    expect(src.streamUrl).toContain('/api/v1/nodes/')
    // directStreamUrl must be absent for private/loopback addresses
    // (remote-hub:3001 is not a real public address — isPrivateUrl treats it as non-private
    //  but we verify the base_url is not leaked in any non-standard field)
    expect(src).not.toHaveProperty('upstreamUrl')
    expect(src).not.toHaveProperty('remoteBaseUrl')
    expect(src).not.toHaveProperty('authorization')
    expect(src).not.toHaveProperty('token')
  })

  // Test 18: Signed token payload does not contain raw session token
  it('signed token payload does not contain raw session token (only a hash)', () => {
    const rawToken = 'my-raw-session-token-value-12345'
    const sid = deriveSessionBinding(rawToken)

    // sid must be a hash — not the raw token
    expect(sid).not.toBe(rawToken)
    // sid must be a 32-char hex string (first 32 chars of SHA-256)
    expect(sid).toMatch(/^[0-9a-f]{32}$/)

    // Build a token and inspect its payload
    const token = signPlaybackRefreshToken(
      { sub: 'u', sid, nodeId: 'n', mediaId: 'm' },
      TEST_REFRESH_SECRET,
      600000
    )
    // Decode payload (before the dot)
    const payloadB64 = token.split('.')[0]
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(payloadB64.length / 4) * 4, '='
    )
    const payloadStr = Buffer.from(padded, 'base64').toString('utf8')

    // Raw session token must NOT be in the payload
    expect(payloadStr).not.toContain(rawToken)
    // Signing secret must NOT be in the payload
    expect(payloadStr).not.toContain(TEST_REFRESH_SECRET)
  })

  // Test 19: Token payload does not contain federation bearer token or filesystem path
  it('token payload does not contain federation bearer token or filesystem path', () => {
    const fedToken = 'federation-bearer-token-never-in-payload'
    const path = '/home/user/media/video.mkv'

    // Build a normal token
    const token = signPlaybackRefreshToken(
      { sub: 'u', sid: 'some-hash', nodeId: 'n', mediaId: 'm' },
      TEST_REFRESH_SECRET,
      600000
    )
    // Decode and inspect
    const payloadB64 = token.split('.')[0]
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(payloadB64.length / 4) * 4, '='
    )
    const payloadStr = Buffer.from(padded, 'base64').toString('utf8')

    expect(payloadStr).not.toContain(fedToken)
    expect(payloadStr).not.toContain(path)
    // Only the explicitly provided fields should be in the payload
    const parsed = JSON.parse(payloadStr)
    const allowedKeys = new Set(['v', 'purpose', 'sub', 'sid', 'nodeId', 'mediaId', 'iat', 'exp', 'nonce'])
    for (const key of Object.keys(parsed)) {
      expect(allowedKeys.has(key)).toBe(true)
    }
  })
})

// ─── Regression tests ─────────────────────────────────────────────────────────

describe('Regression: existing behavior unchanged with signed tokens in play', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-srt-reg-${crypto.randomUUID()}`)
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

  // Test 20: Session-auth path (no ?rt) still works — existing cookie-based refresh
  it('session-auth path (no ?rt) still works with cookie — existing refresh behavior', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)
    mockFetchReadyIntent()

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    const src = body.data
    // refreshUrl must now contain a signed ?rt= token
    expect(src.refreshUrl).toContain('?rt=')
    // streamUrl must be the proxy path
    expect(src.streamUrl).toContain('/api/v1/nodes/')
    // The signed token in refreshUrl must be verifiable
    const rtParam = new URL(`http://x${src.refreshUrl}`).searchParams.get('rt')
    expect(rtParam).toBeTruthy()
    const verifyResult = verifyPlaybackRefreshToken(rtParam!, TEST_REFRESH_SECRET)
    expect(verifyResult.ok).toBe(true)
  })

  // Test 21: directStreamUrl still omitted for private base_url
  it('directStreamUrl still omitted for private/loopback base_url', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir, {
      baseUrl: 'http://192.168.1.50:3001',
    })
    mockFetchReadyIntent()

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const src = JSON.parse(res.body).data
    // Private base_url → directStreamUrl must be absent
    expect(src.directStreamUrl).toBeUndefined()
    expect(src.proxyStreamUrl).toBeDefined()
  })

  // Test 22: capabilities.supportsTranscode remains false
  it('capabilities.supportsTranscode remains false in refresh response', async () => {
    const { remoteNodeId, itemId } = await insertRemoteSetup(db, testDir)
    mockFetchReadyIntent()

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/media/${itemId}/playback-source`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const src = JSON.parse(res.body).data
    expect(src.capabilities.supportsTranscode).toBe(false)
  })
})
