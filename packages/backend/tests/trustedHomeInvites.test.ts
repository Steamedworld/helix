/**
 * Trusted Home invite flow tests.
 *
 * Covers:
 *   - Create invite requires admin auth
 *   - Normal user cannot create invite (403)
 *   - POST response includes token field (shown once)
 *   - GET list never includes token field
 *   - Revoke invite sets revoked_at
 *   - Accept invite requires admin
 *   - Accept invite with malformed input returns 400
 *   - Accept invite tests remote health (mocked fetch)
 *   - Accept invite creates Trusted Home entry
 *   - Accept invite does NOT store raw token in plaintext (checks DB)
 *   - Accept invite prevents duplicate for same server_address
 *   - Existing federation/catalog routes still work (regression)
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
import { nodes, trustedHomeInvites } from '../src/db/schema'
import { decryptApiKey } from '../src/services/integrations/encryption'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

// Helper: create a non-admin user and return their session cookie
// Requires the adminCookie to already be established (avoids double setup).
async function setupNonAdminUser(app: ReturnType<typeof buildServer>, adminCookie: string) {
  const createRes = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { Cookie: adminCookie },
    payload: {
      username: 'regular_user',
      password: 'password123!',
      displayName: 'Regular User',
      role: 'user',
    },
  })
  expect(createRes.statusCode, 'create user failed: ' + createRes.body).toBe(201)

  // Log in as that user
  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'regular_user', password: 'password123!' },
  })
  expect(loginRes.statusCode, 'login failed: ' + loginRes.body).toBe(200)

  const setCookie = loginRes.headers['set-cookie']
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie ?? ''
  const match = cookieStr.match(/helix_session=([^;]+)/)
  return `helix_session=${match?.[1] ?? ''}`
}

// ─── Suite setup ──────────────────────────────────────────────────────────────

describe('Trusted Home invites — create', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-invites-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('requires admin — unauthenticated → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/trusted-home-invites' })
    expect(res.statusCode).toBe(401)
  })

  it('non-admin cannot create invite → 403', async () => {
    const userCookie = await setupNonAdminUser(app, adminCookie)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: userCookie },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('admin can create invite — response includes token once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
      payload: { label: 'For Bob', expires_in_days: 30 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    // invite object contains token
    expect(typeof body.data.invite.token).toBe('string')
    expect(body.data.invite.token.length).toBeGreaterThan(0)
    // compact base64url is present
    expect(typeof body.data.compact).toBe('string')
    expect(body.data.compact.length).toBeGreaterThan(0)
    // invite metadata
    expect(body.data.invite.helix_invite).toBe('1')
    expect(body.data.invite.label).toBe('For Bob')
    expect(body.data.invite.expires_at).not.toBeNull()
    expect(body.data.invite.warning).toMatch(/trusted Helix home/)
  })

  it('compact form decodes back to valid invite', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
      payload: { label: 'Test compact' },
    })
    const body = JSON.parse(res.body)
    const compact: string = body.data.compact

    // Decode manually
    const padded =
      compact.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (compact.length % 4)) % 4)
    const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))

    expect(decoded.helix_invite).toBe('1')
    expect(typeof decoded.token).toBe('string')
    expect(decoded.token).toBe(body.data.invite.token)
  })

  it('invite id stored in DB and token_hash is SHA-256 of raw token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
      payload: {},
    })
    const body = JSON.parse(res.body)
    const { token, invite_id } = body.data.invite

    // Look up in DB
    const [row] = await db
      .select()
      .from(trustedHomeInvites)
      .where(eq(trustedHomeInvites.id, invite_id))

    expect(row).toBeDefined()
    // token_hash must match SHA-256 of raw token
    const { createHash } = await import('crypto')
    const expected = createHash('sha256').update(token).digest('hex')
    expect(row.token_hash).toBe(expected)
    // raw token must NOT be stored anywhere in the row
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('invalid expires_in_days → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
      payload: { expires_in_days: 999 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('base_url_warning present when server built without baseUrl', async () => {
    // Build server without baseUrl
    const testDir2 = join(tmpdir(), `helix-inv-nobase-${crypto.randomUUID()}`)
    mkdirSync(testDir2, { recursive: true })
    const db2 = createTestDb(testDir2)
    const id2 = await bootstrap(db2, testDir2)
    const app2 = buildServer(db2, id2, undefined, testDir2)
    await app2.ready()
    const cookie2 = await setupAuth(app2)

    const res = await app2.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: cookie2 },
      payload: {},
    })
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    // Should warn about missing BASE_URL
    expect(typeof body.data.base_url_warning).toBe('string')
    expect(body.data.base_url_warning).toMatch(/BASE_URL/)

    await app2.close()
    rmSync(testDir2, { recursive: true, force: true })
  })
})

// ─── List invites ─────────────────────────────────────────────────────────────

describe('Trusted Home invites — list', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-invites-list-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('GET list never includes token field', async () => {
    // Create a couple of invites
    await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
      payload: { label: 'Invite 1' },
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
      payload: { label: 'Invite 2' },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.length).toBe(2)

    for (const invite of body.data) {
      expect(invite.token).toBeUndefined()
      expect(invite.token_hash).toBeUndefined()
      expect(invite.id).toBeDefined()
      expect(invite.label).toBeDefined()
    }
  })

  it('list requires admin → 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/trusted-home-invites' })
    expect(res.statusCode).toBe(401)
  })
})

// ─── Revoke invite ────────────────────────────────────────────────────────────

describe('Trusted Home invites — revoke', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-invites-revoke-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('revoke sets revoked_at and keeps the row', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
      payload: { label: 'To revoke' },
    })
    const { invite_id } = JSON.parse(createRes.body).data.invite

    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/trusted-home-invites/${invite_id}`,
      headers: { Cookie: adminCookie },
    })
    expect(revokeRes.statusCode).toBe(200)
    const revokeBody = JSON.parse(revokeRes.body)
    expect(revokeBody.data.revoked).toBe(true)

    // Row should still exist with revoked_at set
    const [row] = await db
      .select()
      .from(trustedHomeInvites)
      .where(eq(trustedHomeInvites.id, invite_id))
    expect(row).toBeDefined()
    expect(row.revoked_at).not.toBeNull()
  })

  it('revoke nonexistent invite → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/trusted-home-invites/no-such-id',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('revoked invite still appears in list with revoked_at', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
      payload: {},
    })
    const { invite_id } = JSON.parse(createRes.body).data.invite

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/trusted-home-invites/${invite_id}`,
      headers: { Cookie: adminCookie },
    })

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
    })
    const listBody = JSON.parse(listRes.body)
    const found = listBody.data.find((i: { id: string }) => i.id === invite_id)
    expect(found).toBeDefined()
    expect(found.revoked_at).not.toBeNull()
  })
})

// ─── Accept invite ────────────────────────────────────────────────────────────

describe('Trusted Home invites — accept', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  function buildMockInvite(overrides?: Record<string, unknown>) {
    return {
      helix_invite: '1',
      home_name: "Alice's Helix",
      server_address: 'http://alice.helix.local:3001',
      token: 'abc123tokenabc123tokenabc123tokenabc123',
      invite_id: 'inv-001',
      label: 'For Bob',
      expires_at: null,
      generated_at: new Date().toISOString(),
      warning: 'treat as password',
      ...overrides,
    }
  }

  function encodeCompact(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-accept-inv-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('requires admin → 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      payload: { invite: 'anything' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('non-admin cannot accept invite → 403', async () => {
    const userCookie = await setupNonAdminUser(app, adminCookie)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: userCookie },
      payload: { invite: 'anything' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('missing invite field → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('malformed base64url → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: 'not-base64-!!!!' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('malformed JSON string → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: '{ broken json' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('invite missing required fields → 400', async () => {
    const noToken = encodeCompact({ helix_invite: '1', server_address: 'http://x.local' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: noToken },
    })
    expect(res.statusCode).toBe(400)
  })

  it('invite with unsupported version → 400', async () => {
    const bad = encodeCompact({ helix_invite: '99', server_address: 'http://x.local', token: 'tok', invite_id: 'i1' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: bad },
    })
    expect(res.statusCode).toBe(400)
  })

  it('invite with empty server_address → 400', async () => {
    const inv = encodeCompact(buildMockInvite({ server_address: '' }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv },
    })
    expect(res.statusCode).toBe(400)
  })

  it('invite with invalid server_address URL → 400', async () => {
    const inv = encodeCompact(buildMockInvite({ server_address: 'not-a-url' }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv },
    })
    expect(res.statusCode).toBe(400)
  })

  it('remote health check fails → 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')))

    const inv = encodeCompact(buildMockInvite())
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv },
    })
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
  })

  it('successful accept-invite creates Trusted Home node', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { status: 'online', nodeId: 'remote-1', nodeName: "Alice's Helix" } }),
    }))

    const inv = encodeCompact(buildMockInvite())
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.connected).toBe(true)
    expect(body.data.node_id).toBeDefined()
    expect(body.data.sync_available).toBe(true)
    expect(body.data.message).toMatch(/library/i)

    // Verify node was created in DB
    const allNodes = await db.select().from(nodes)
    const remote = allNodes.find((n) => n.base_url === 'http://alice.helix.local:3001')
    expect(remote).toBeDefined()
    expect(remote!.kind).toBe('remote')
  })

  it('successful accept-invite does NOT store raw token in plaintext', async () => {
    const rawToken = 'super-secret-token-abc123xyz'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { status: 'online' } }),
    }))

    const inv = encodeCompact(buildMockInvite({ token: rawToken }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)

    // Fetch the node from DB and ensure raw token is not stored
    const allNodes = await db.select().from(nodes)
    const remote = allNodes.find((n) => n.base_url === 'http://alice.helix.local:3001')
    expect(remote).toBeDefined()

    // api_token_encrypted must not equal raw token
    expect(remote!.api_token_encrypted).not.toBe(rawToken)
    // Must be encrypted format (iv:authTag:ciphertext)
    expect(remote!.api_token_encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)

    // Decrypt to confirm correct token was stored
    const decrypted = decryptApiKey(remote!.api_token_encrypted!, testDir)
    expect(decrypted).toBe(rawToken)
  })

  it('accepts invite as JSON string (not just base64url)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { status: 'online' } }),
    }))

    const inv = JSON.stringify(buildMockInvite({ server_address: 'http://bob.helix.local:3001' }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.connected).toBe(true)
  })

  it('duplicate server_address returns already_connected without creating new node', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { status: 'online' } }),
    }))

    const inv = encodeCompact(buildMockInvite())

    // Accept once
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv },
    })
    expect(first.statusCode).toBe(200)
    expect(JSON.parse(first.body).data.connected).toBe(true)

    // Accept again with same server_address
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv },
    })
    expect(second.statusCode).toBe(200)
    const secondBody = JSON.parse(second.body)
    expect(secondBody.ok).toBe(true)
    expect(secondBody.data.already_connected).toBe(true)
    expect(secondBody.data.node_id).toBeDefined()

    // Should still have exactly 2 nodes (local + 1 remote, not 2 remotes)
    const allNodes = await db.select().from(nodes)
    const remotes = allNodes.filter((n) => n.kind === 'remote')
    expect(remotes.length).toBe(1)
  })
})

// ─── Regression: existing federation endpoints ────────────────────────────────

describe('Regression — existing federation endpoints unaffected', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawFedToken: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-inv-regression-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    rawFedToken = JSON.parse(tokenRes.body).data.token
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('GET /federation/health still works', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/health',
      headers: { Authorization: `Bearer ${rawFedToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('online')
  })

  it('GET /federation/catalog still works', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/catalog',
      headers: { Authorization: `Bearer ${rawFedToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data.items)).toBe(true)
  })

  it('GET /nodes still lists nodes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
  })
})
