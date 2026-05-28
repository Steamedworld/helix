/**
 * Trusted Home invite lifecycle hardening tests.
 *
 * Covers:
 *   VERIFY endpoint:
 *   - verify rejects missing/no token → 403
 *   - verify rejects invalid/unknown token → 403
 *   - verify rejects expired invite → 403
 *   - verify rejects revoked invite → 403
 *   - verify rejects used invite → 403
 *   - verify returns safe source-home info (no token_hash, no raw token)
 *
 *   CONSUME endpoint:
 *   - consume marks used_at
 *   - consume rejects invalid token → 403
 *   - consume rejects already-used token → 403
 *   - consume rejects revoked token → 403
 *   - consume rejects expired token → 403
 *   - consume stores connecting_home_name and connecting_home_address
 *
 *   ACCEPT-INVITE integration:
 *   - accept-invite calls verify before creating node (verify returns 403 → node not created)
 *   - accept-invite rejects expired invite (source verify returns 403)
 *   - accept-invite marks used after successful connection (consume mock called with token)
 *   - accept-invite handles consume failure with warning (consume 500 → node still created)
 *   - syncNow=true triggers catalog sync (mock catalog endpoint returns items)
 *   - syncNow=false skips sync (no sync_result in response)
 *   - sync failure returns sync_warning without deleting node
 *
 *   REGRESSION:
 *   - invite list still never returns raw token or token_hash
 *   - normal users cannot manage invites (403)
 *   - existing manual node setup still works (POST /nodes)
 *   - existing federation/health still works
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

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

async function setupNonAdminUser(app: ReturnType<typeof buildServer>, adminCookie: string) {
  const createRes = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { Cookie: adminCookie },
    payload: {
      username: 'regular_user_lc',
      password: 'password123!',
      displayName: 'Regular User LC',
      role: 'user',
    },
  })
  expect(createRes.statusCode, 'create user: ' + createRes.body).toBe(201)

  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'regular_user_lc', password: 'password123!' },
  })
  expect(loginRes.statusCode, 'login: ' + loginRes.body).toBe(200)

  const setCookie = loginRes.headers['set-cookie']
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie ?? ''
  const match = cookieStr.match(/helix_session=([^;]+)/)
  return `helix_session=${match?.[1] ?? ''}`
}

// Helper: create an invite and return raw token + invite_id
async function createInvite(
  app: ReturnType<typeof buildServer>,
  adminCookie: string,
  overrides?: { expires_in_days?: number; label?: string }
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/trusted-home-invites',
    headers: { Cookie: adminCookie },
    payload: overrides ?? {},
  })
  expect(res.statusCode, 'create invite: ' + res.body).toBe(200)
  const body = JSON.parse(res.body)
  return {
    rawToken: body.data.invite.token as string,
    inviteId: body.data.invite.invite_id as string,
  }
}

// Helper: encode an invite object as compact base64url
function encodeCompact(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function buildMockInvite(overrides?: Record<string, unknown>) {
  return {
    helix_invite: '1',
    home_name: "Alice's Helix",
    server_address: 'http://alice.helix.local:3001',
    token: 'mock-token-abc123def456abc123def456abc123',
    invite_id: 'inv-mock-001',
    label: 'For Bob',
    expires_at: null,
    generated_at: new Date().toISOString(),
    warning: 'treat as password',
    ...overrides,
  }
}

// ─── Verify endpoint tests ────────────────────────────────────────────────────

describe('Invite verify endpoint', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-lc-verify-${crypto.randomUUID()}`)
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

  it('verify rejects missing Authorization header → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/verify',
    })
    expect(res.statusCode).toBe(403)
  })

  it('verify rejects non-Bearer Authorization → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/verify',
      headers: { Authorization: 'Basic sometoken' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('verify rejects unknown token → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/verify',
      headers: { Authorization: 'Bearer no-such-token-xyz' },
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
  })

  it('verify rejects expired invite → 403', async () => {
    // Create an invite and manually set expires_at to the past
    const { rawToken, inviteId } = await createInvite(app, adminCookie)
    const pastMs = Date.now() - 1000
    await db
      .update(trustedHomeInvites)
      .set({ expires_at: pastMs, updated_at: Date.now() })
      .where(eq(trustedHomeInvites.id, inviteId))

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/verify',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toMatch(/expired/i)
  })

  it('verify rejects revoked invite → 403', async () => {
    const { rawToken, inviteId } = await createInvite(app, adminCookie)

    // Revoke it
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/trusted-home-invites/${inviteId}`,
      headers: { Cookie: adminCookie },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/verify',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toMatch(/revoked/i)
  })

  it('verify rejects used invite → 403', async () => {
    const { rawToken, inviteId } = await createInvite(app, adminCookie)

    // Mark as used directly
    await db
      .update(trustedHomeInvites)
      .set({ used_at: Date.now(), updated_at: Date.now() })
      .where(eq(trustedHomeInvites.id, inviteId))

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/verify',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toMatch(/already been used/i)
  })

  it('verify returns safe info for valid token — no token_hash or raw token', async () => {
    const { rawToken } = await createInvite(app, adminCookie, { label: 'Test invite' })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/verify',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.valid).toBe(true)
    expect(body.data.home_name).toBeDefined()
    expect(body.data.server_address).toBeDefined()
    expect(body.data.capabilities).toBeDefined()
    expect(body.data.invite_id).toBeDefined()

    // Must NOT contain sensitive fields
    const serialized = JSON.stringify(body.data)
    expect(serialized).not.toContain('token_hash')
    expect(serialized).not.toContain(rawToken)
  })

  it('verify does NOT mark used_at', async () => {
    const { rawToken, inviteId } = await createInvite(app, adminCookie)

    await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/verify',
      headers: { Authorization: `Bearer ${rawToken}` },
    })

    const [row] = await db
      .select()
      .from(trustedHomeInvites)
      .where(eq(trustedHomeInvites.id, inviteId))
    // used_at should still be null after verify
    expect(row.used_at).toBeNull()
  })
})

// ─── Consume endpoint tests ───────────────────────────────────────────────────

describe('Invite consume endpoint', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-lc-consume-${crypto.randomUUID()}`)
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

  it('consume rejects missing token → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/consume',
    })
    expect(res.statusCode).toBe(403)
  })

  it('consume rejects invalid/unknown token → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/consume',
      headers: { Authorization: 'Bearer no-such-token-xyz' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('consume marks used_at', async () => {
    const { rawToken, inviteId } = await createInvite(app, adminCookie)

    const beforeMs = Date.now()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/consume',
      headers: { Authorization: `Bearer ${rawToken}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.consumed).toBe(true)
    expect(body.data.used_at).toBeDefined()

    // Verify DB state
    const [row] = await db
      .select()
      .from(trustedHomeInvites)
      .where(eq(trustedHomeInvites.id, inviteId))
    expect(row.used_at).not.toBeNull()
    expect(row.used_at!).toBeGreaterThanOrEqual(beforeMs)
  })

  it('consume stores connecting_home_name and connecting_home_address', async () => {
    const { rawToken, inviteId } = await createInvite(app, adminCookie)

    await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/consume',
      headers: {
        Authorization: `Bearer ${rawToken}`,
        'Content-Type': 'application/json',
      },
      payload: {
        connecting_home_name: 'Bob Helix',
        connecting_home_address: 'http://bob.helix.local:3001',
      },
    })

    const [row] = await db
      .select()
      .from(trustedHomeInvites)
      .where(eq(trustedHomeInvites.id, inviteId))
    expect(row.used_by_home_name).toBe('Bob Helix')
    expect(row.used_by_address).toBe('http://bob.helix.local:3001')
  })

  it('consume rejects already-used token → 403', async () => {
    const { rawToken } = await createInvite(app, adminCookie)

    // First consume
    await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/consume',
      headers: { Authorization: `Bearer ${rawToken}` },
    })

    // Second consume — should fail
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/consume',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toMatch(/already been used/i)
  })

  it('consume rejects revoked invite → 403', async () => {
    const { rawToken, inviteId } = await createInvite(app, adminCookie)

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/trusted-home-invites/${inviteId}`,
      headers: { Cookie: adminCookie },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/consume',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/revoked/i)
  })

  it('consume rejects expired invite → 403', async () => {
    const { rawToken, inviteId } = await createInvite(app, adminCookie)

    await db
      .update(trustedHomeInvites)
      .set({ expires_at: Date.now() - 1000, updated_at: Date.now() })
      .where(eq(trustedHomeInvites.id, inviteId))

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/consume',
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/expired/i)
  })
})

// ─── Accept-invite integration tests ─────────────────────────────────────────

describe('Accept-invite: verify/consume integration', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-lc-accept-${crypto.randomUUID()}`)
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

  it('accept-invite calls verify first — verify 403 → node NOT created', async () => {
    // fetch mock: verify returns 403, health would succeed but should not be called
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/invites/verify')) {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: async () => ({ ok: false, error: 'This invite has expired.' }),
        })
      }
      // Health check — should not be reached
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, data: { status: 'online' } }),
      })
    }))

    const inv = encodeCompact(buildMockInvite())
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv },
    })

    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)

    // No new remote node should have been created
    const allNodes = await db.select().from(nodes)
    const remotes = allNodes.filter((n) => n.kind === 'remote')
    expect(remotes.length).toBe(0)
  })

  it('accept-invite: verify unreachable → 502 with "Cannot reach source home"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/invites/verify')) {
        return Promise.reject(new Error('Connection refused'))
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    }))

    const inv = encodeCompact(buildMockInvite())
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv },
    })
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body)
    expect(body.error).toMatch(/Cannot reach source home/i)
  })

  it('accept-invite: successful connect calls consume (verify ok, health ok, consume called)', async () => {
    const consumeCalls: string[] = []

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url)
      if (urlStr.includes('/invites/verify')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, data: { valid: true, home_name: "Alice's Helix", server_address: 'http://alice.helix.local:3001', capabilities: {}, label: null, expires_at: null, invite_id: 'inv-001' } }),
        })
      }
      if (urlStr.includes('/invites/consume')) {
        consumeCalls.push(urlStr)
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, data: { consumed: true, used_at: new Date().toISOString() } }),
        })
      }
      // health + capabilities
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, data: { status: 'online', nodeId: 'remote-1', nodeName: "Alice's Helix" } }),
      })
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
    expect(body.data.connected).toBe(true)
    // consume should have been called
    expect(consumeCalls.length).toBeGreaterThan(0)
    expect(consumeCalls[0]).toContain('/invites/consume')
  })

  it('accept-invite: consume failure returns consume_warning, node still created', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url)
      if (urlStr.includes('/invites/verify')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, data: { valid: true } }),
        })
      }
      if (urlStr.includes('/invites/consume')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ ok: false, error: 'Internal error' }),
        })
      }
      // health + capabilities
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, data: { status: 'online' } }),
      })
    }))

    const inv = encodeCompact(buildMockInvite({ server_address: 'http://carol.helix.local:3001' }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.connected).toBe(true)
    // Node should be created
    expect(body.data.node_id).toBeDefined()
    // Warning should be present
    expect(body.data.consume_warning).toBeDefined()
    expect(typeof body.data.consume_warning).toBe('string')

    // Confirm node exists in DB
    const allNodes = await db.select().from(nodes)
    const remote = allNodes.find((n) => n.base_url === 'http://carol.helix.local:3001')
    expect(remote).toBeDefined()
  })

  it('syncNow=true triggers catalog sync — sync_result present', async () => {
    const mockCatalog = {
      nodeId: 'remote-1',
      nodeName: "Alice's Helix",
      exportedAt: Date.now(),
      libraries: [{ id: 'lib-1', name: 'Movies', kind: 'movies', itemCount: 2 }],
      items: [
        {
          id: 'item-1', library_id: 'lib-1', parent_id: null, kind: 'movie',
          title: 'Test Movie', sort_title: null, year: 2024, overview: null,
          has_poster: false, has_backdrop: false, original_title: null,
          release_date: null, content_rating: null, runtime_seconds: null,
          season_number: null, episode_number: null, episode_title: null,
          absolute_episode_number: null, metadata_status: 'unknown',
          external_tmdb_id: null, external_tvdb_id: null,
          updated_at: new Date().toISOString(),
        },
        {
          id: 'item-2', library_id: 'lib-1', parent_id: null, kind: 'movie',
          title: 'Test Movie 2', sort_title: null, year: 2023, overview: null,
          has_poster: false, has_backdrop: false, original_title: null,
          release_date: null, content_rating: null, runtime_seconds: null,
          season_number: null, episode_number: null, episode_title: null,
          absolute_episode_number: null, metadata_status: 'unknown',
          external_tmdb_id: null, external_tvdb_id: null,
          updated_at: new Date().toISOString(),
        },
      ],
      versions: [],
      files: [],
    }

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url)
      if (urlStr.includes('/invites/verify')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, data: { valid: true } }),
        })
      }
      if (urlStr.includes('/invites/consume')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, data: { consumed: true, used_at: new Date().toISOString() } }),
        })
      }
      if (urlStr.includes('/federation/catalog')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, data: mockCatalog }),
        })
      }
      // health + capabilities
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, data: { status: 'online' } }),
      })
    }))

    const inv = encodeCompact(buildMockInvite({ server_address: 'http://dave.helix.local:3001' }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv, syncNow: true },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.connected).toBe(true)
    expect(body.data.sync_result).toBeDefined()
    expect(body.data.sync_result.items_synced).toBe(2)
    expect(body.data.sync_warning).toBeUndefined()
  })

  it('syncNow=false skips catalog sync — no sync_result', async () => {
    let catalogCalled = false
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url)
      if (urlStr.includes('/invites/verify')) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { valid: true } }) })
      }
      if (urlStr.includes('/invites/consume')) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { consumed: true, used_at: new Date().toISOString() } }) })
      }
      if (urlStr.includes('/federation/catalog')) {
        catalogCalled = true
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { nodeId: 'r', nodeName: 'R', exportedAt: Date.now(), libraries: [], items: [], versions: [], files: [] } }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { status: 'online' } }) })
    }))

    const inv = encodeCompact(buildMockInvite({ server_address: 'http://eve.helix.local:3001' }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv, syncNow: false },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.connected).toBe(true)
    expect(body.data.sync_result).toBeUndefined()
    expect(catalogCalled).toBe(false)
  })

  it('sync failure returns sync_warning without deleting node', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url)
      if (urlStr.includes('/invites/verify')) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { valid: true } }) })
      }
      if (urlStr.includes('/invites/consume')) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { consumed: true, used_at: new Date().toISOString() } }) })
      }
      if (urlStr.includes('/federation/catalog')) {
        return Promise.reject(new Error('Catalog sync network error'))
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { status: 'online' } }) })
    }))

    const inv = encodeCompact(buildMockInvite({ server_address: 'http://frank.helix.local:3001' }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-homes/accept-invite',
      headers: { Cookie: adminCookie },
      payload: { invite: inv, syncNow: true },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.connected).toBe(true)
    expect(body.data.sync_warning).toBeDefined()
    expect(body.data.sync_result).toBeUndefined()
    // Node must still exist
    const allNodes = await db.select().from(nodes)
    const remote = allNodes.find((n) => n.base_url === 'http://frank.helix.local:3001')
    expect(remote).toBeDefined()
  })
})

// ─── Regression tests ─────────────────────────────────────────────────────────

describe('Regression: existing functionality unaffected', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-lc-regression-${crypto.randomUUID()}`)
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

  it('invite list never returns raw token or token_hash', async () => {
    const { rawToken } = await createInvite(app, adminCookie, { label: 'Regression invite' })

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
    })
    expect(listRes.statusCode).toBe(200)
    const body = JSON.parse(listRes.body)
    expect(Array.isArray(body.data)).toBe(true)

    for (const inv of body.data) {
      expect(inv.token).toBeUndefined()
      expect(inv.token_hash).toBeUndefined()
      expect(JSON.stringify(inv)).not.toContain(rawToken)
    }
  })

  it('normal users cannot manage invites — create returns 403', async () => {
    const userCookie = await setupNonAdminUser(app, adminCookie)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: userCookie },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('normal users cannot list invites — returns 403', async () => {
    const userCookie = await setupNonAdminUser(app, adminCookie)
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: userCookie },
    })
    expect(res.statusCode).toBe(403)
  })

  it('existing manual node setup (POST /nodes) still works', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: { Cookie: adminCookie },
      payload: {
        name: 'Manual Node',
        base_url: 'http://manual.helix.local:3001',
        api_token: 'manual-token-xyz',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.name).toBe('Manual Node')
    expect(body.data.kind).toBe('remote')
  })

  it('existing GET /federation/health still works with federation token', async () => {
    // Generate federation token
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    const rawFedToken = JSON.parse(tokenRes.body).data.token

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/health',
      headers: { Authorization: `Bearer ${rawFedToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.status).toBe('online')
  })

  it('verify/consume endpoints reject federation (long-lived) tokens — token not in invite table', async () => {
    // Generate federation token (long-lived)
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    const rawFedToken = JSON.parse(tokenRes.body).data.token

    // Verify should reject it (not found in invite table)
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/verify',
      headers: { Authorization: `Bearer ${rawFedToken}` },
    })
    expect(verifyRes.statusCode).toBe(403)

    // Consume should also reject it
    const consumeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/consume',
      headers: { Authorization: `Bearer ${rawFedToken}` },
    })
    expect(consumeRes.statusCode).toBe(403)
  })

  it('invite list includes used_by_home_name and used_by_address fields', async () => {
    const { rawToken, inviteId } = await createInvite(app, adminCookie)

    // Consume with metadata
    await app.inject({
      method: 'POST',
      url: '/api/v1/federation/invites/consume',
      headers: {
        Authorization: `Bearer ${rawToken}`,
        'Content-Type': 'application/json',
      },
      payload: {
        connecting_home_name: 'Bob Home',
        connecting_home_address: 'http://bob.example.com',
      },
    })

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
    })
    const listBody = JSON.parse(listRes.body)
    const found = listBody.data.find((i: { id: string }) => i.id === inviteId)
    expect(found).toBeDefined()
    expect(found.used_by_home_name).toBe('Bob Home')
    expect(found.used_by_address).toBe('http://bob.example.com')
    // But still no raw token or hash
    expect(found.token).toBeUndefined()
    expect(found.token_hash).toBeUndefined()
  })
})
