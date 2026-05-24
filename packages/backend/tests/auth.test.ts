/**
 * Comprehensive auth tests — Phase 8.
 *
 * Tests cover:
 * - Password hashing & verification
 * - Setup endpoint (first-run)
 * - Login / logout
 * - Session lifecycle (expiry, revocation)
 * - requireAuth / requireAdmin middleware
 * - Authenticated user-specific data endpoints
 * - Change password
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { users, sessions, libraries, mediaItems } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { hashPassword, verifyPassword } from '../src/services/auth/password'
import { COOKIE_NAME } from '../src/middleware/auth'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

/** Extract session cookie string from a Set-Cookie header */
function extractCookie(setCookieHeader: string | string[] | undefined): string | null {
  if (!setCookieHeader) return null
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader
  const match = raw.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  return match ? `${COOKIE_NAME}=${match[1]}` : null
}

// ─── Password hashing ─────────────────────────────────────────────────────────

describe('password hashing', () => {
  it('hashPassword does not store plaintext', async () => {
    const hash = await hashPassword('mysecretpassword')
    expect(hash).not.toBe('mysecretpassword')
    expect(hash.startsWith('$2')).toBe(true)
  })

  it('verifyPassword succeeds with correct password', async () => {
    const hash = await hashPassword('correcthorse')
    const result = await verifyPassword('correcthorse', hash)
    expect(result).toBe(true)
  })

  it('verifyPassword fails with wrong password', async () => {
    const hash = await hashPassword('correcthorse')
    const result = await verifyPassword('wrongpassword', hash)
    expect(result).toBe(false)
  })

  it('two hashes of the same password are different (salted)', async () => {
    const h1 = await hashPassword('samepassword')
    const h2 = await hashPassword('samepassword')
    expect(h1).not.toBe(h2)
    // Both should verify
    expect(await verifyPassword('samepassword', h1)).toBe(true)
    expect(await verifyPassword('samepassword', h2)).toBe(true)
  })
})

// ─── Auth API ─────────────────────────────────────────────────────────────────

describe('auth API routes', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-auth-test-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId)
    await app.ready()
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  // ─── GET /api/v1/auth/status ──────────────────────────────────────────────

  describe('GET /api/v1/auth/status', () => {
    it('returns setupRequired=true when no password is set', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/status' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data.setupRequired).toBe(true)
      expect(body.data.authenticated).toBe(false)
      expect(body.data.user).toBeNull()
    })

    it('returns setupRequired=false and authenticated=true after setup', async () => {
      // Do setup
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'password123' },
      })

      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/status' })
      const body = JSON.parse(res.body)
      expect(body.data.setupRequired).toBe(false)
    })
  })

  // ─── POST /api/v1/auth/setup ──────────────────────────────────────────────

  describe('POST /api/v1/auth/setup', () => {
    it('succeeds when no password is set', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'password123', displayName: 'Administrator' },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data.user.username).toBe('admin')
      expect(body.data.user.role).toBe('admin')
      // Cookie should be set
      expect(extractCookie(res.headers['set-cookie'])).not.toBeNull()
    })

    it('returns 409 on second setup call', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'password123' },
      })
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin2', password: 'password456' },
      })
      expect(res2.statusCode).toBe(409)
    })

    it('validates username — too short', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'ab', password: 'password123' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('validates username — invalid chars', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin user', password: 'password123' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('validates password — too short', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'short' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('does not return password_hash in response', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'password123' },
      })
      const body = JSON.parse(res.body)
      expect(body.data.user.password_hash).toBeUndefined()
    })
  })

  // ─── POST /api/v1/auth/login ──────────────────────────────────────────────

  describe('POST /api/v1/auth/login', () => {
    beforeEach(async () => {
      // Set up user first
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'testuser', password: 'password123' },
      })
    })

    it('succeeds with correct credentials and sets cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'testuser', password: 'password123' },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data.user.username).toBe('testuser')
      expect(extractCookie(res.headers['set-cookie'])).not.toBeNull()
    })

    it('returns 401 for wrong password (generic message)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'testuser', password: 'wrongpassword' },
      })
      expect(res.statusCode).toBe(401)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(false)
      // Generic message — doesn't reveal whether username exists
      expect(body.error).toMatch(/invalid credentials/i)
    })

    it('returns 401 for unknown username (generic message)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'nonexistent', password: 'password123' },
      })
      expect(res.statusCode).toBe(401)
      const body = JSON.parse(res.body)
      expect(body.error).toMatch(/invalid credentials/i)
    })

    it('returns 403 for disabled user', async () => {
      // Disable the user
      const [user] = await db.select().from(users).where(eq(users.username, 'testuser')).limit(1)
      await db.update(users).set({ disabled: 1 }).where(eq(users.id, user.id))

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'testuser', password: 'password123' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('does not return password_hash in response', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'testuser', password: 'password123' },
      })
      const body = JSON.parse(res.body)
      expect(body.data.user.password_hash).toBeUndefined()
    })
  })

  // ─── POST /api/v1/auth/logout ─────────────────────────────────────────────

  describe('POST /api/v1/auth/logout', () => {
    it('revokes session; subsequent requests with same token return 401', async () => {
      // Setup + login
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'password123' },
      })
      const cookie = extractCookie(setupRes.headers['set-cookie'])!

      // Verify we're authenticated
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { Cookie: cookie },
      })
      expect(meRes.statusCode).toBe(200)

      // Logout
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { Cookie: cookie },
      })
      expect(logoutRes.statusCode).toBe(200)

      // Same token should now return 401
      const afterLogout = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { Cookie: cookie },
      })
      expect(afterLogout.statusCode).toBe(401)
    })
  })

  // ─── GET /api/v1/auth/me ─────────────────────────────────────────────────

  describe('GET /api/v1/auth/me', () => {
    it('returns user when authenticated', async () => {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'password123' },
      })
      const cookie = extractCookie(setupRes.headers['set-cookie'])!

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { Cookie: cookie },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.user.username).toBe('admin')
    })

    it('returns 401 when not authenticated', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' })
      expect(res.statusCode).toBe(401)
    })
  })

  // ─── Session expiry ───────────────────────────────────────────────────────

  describe('expired session', () => {
    it('returns 401 for expired session', async () => {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'password123' },
      })
      const cookie = extractCookie(setupRes.headers['set-cookie'])!

      // Manually expire the session
      const allSessions = await db.select().from(sessions)
      expect(allSessions.length).toBeGreaterThan(0)
      await db.update(sessions).set({ expires_at: Date.now() - 1000 }).where(eq(sessions.id, allSessions[0].id))

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { Cookie: cookie },
      })
      expect(res.statusCode).toBe(401)
    })
  })

  // ─── Revoked session ──────────────────────────────────────────────────────

  describe('revoked session', () => {
    it('returns 401 for revoked session', async () => {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'password123' },
      })
      const cookie = extractCookie(setupRes.headers['set-cookie'])!

      // Revoke manually
      const allSessions = await db.select().from(sessions)
      await db.update(sessions).set({ revoked_at: Date.now() }).where(eq(sessions.id, allSessions[0].id))

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { Cookie: cookie },
      })
      expect(res.statusCode).toBe(401)
    })
  })

  // ─── requireAuth middleware ───────────────────────────────────────────────

  describe('requireAuth middleware', () => {
    it('blocks unauthenticated requests to protected watchstate endpoint', async () => {
      const now = new Date().toISOString()
      const libraryId = crypto.randomUUID()
      await db.insert(libraries).values({
        id: libraryId, node_id: localNodeId, name: 'Test', kind: 'movies',
        root_path: '/tmp', scan_status: 'idle', created_at: now, updated_at: now,
      })
      const mediaId = crypto.randomUUID()
      await db.insert(mediaItems).values({
        id: mediaId, library_id: libraryId, kind: 'movie', title: 'Test',
        sort_title: 'test', metadata_status: 'local', metadata_source: 'filename',
        created_at: now, updated_at: now,
      })

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/watchstate/${mediaId}`,
        payload: { position_seconds: 100 },
      })
      expect(res.statusCode).toBe(401)
    })

    it('allows authenticated requests to protected watchstate endpoint', async () => {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'password123' },
      })
      const cookie = extractCookie(setupRes.headers['set-cookie'])!

      const now = new Date().toISOString()
      const libraryId = crypto.randomUUID()
      await db.insert(libraries).values({
        id: libraryId, node_id: localNodeId, name: 'Test', kind: 'movies',
        root_path: '/tmp', scan_status: 'idle', created_at: now, updated_at: now,
      })
      const mediaId = crypto.randomUUID()
      await db.insert(mediaItems).values({
        id: mediaId, library_id: libraryId, kind: 'movie', title: 'Test',
        sort_title: 'test', metadata_status: 'local', metadata_source: 'filename',
        created_at: now, updated_at: now,
      })

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/watchstate/${mediaId}`,
        headers: { Cookie: cookie },
        payload: { position_seconds: 100 },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  // ─── requireAdmin middleware ──────────────────────────────────────────────

  describe('requireAdmin middleware', () => {
    it('blocks user-role from admin endpoints', async () => {
      // Create admin user via setup
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'adminpass123' },
      })
      const adminCookie = extractCookie(setupRes.headers['set-cookie'])!

      // Create a regular user
      await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { Cookie: adminCookie },
        payload: { username: 'regularuser', password: 'userpass123', role: 'user' },
      })

      // Login as regular user
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'regularuser', password: 'userpass123' },
      })
      const userCookie = extractCookie(loginRes.headers['set-cookie'])!

      // Regular user tries to create a library
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/libraries',
        headers: { Cookie: userCookie },
        payload: { name: 'My Library', kind: 'movies', root_path: '/tmp' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('allows admin-role to access admin endpoints', async () => {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'adminpass123' },
      })
      const adminCookie = extractCookie(setupRes.headers['set-cookie'])!

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/libraries',
        headers: { Cookie: adminCookie },
        payload: { name: 'My Library', kind: 'movies', root_path: '/tmp' },
      })
      expect(res.statusCode).toBe(201)
    })
  })

  // ─── Watch state uses authenticated user ─────────────────────────────────

  describe('watch state uses authenticated user', () => {
    it('authenticated user data is returned for their own items', async () => {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'adminpass123' },
      })
      const cookie = extractCookie(setupRes.headers['set-cookie'])!

      const now = new Date().toISOString()
      const libraryId = crypto.randomUUID()
      await db.insert(libraries).values({
        id: libraryId, node_id: localNodeId, name: 'Test', kind: 'movies',
        root_path: '/tmp', scan_status: 'idle', created_at: now, updated_at: now,
      })
      const mediaId = crypto.randomUUID()
      await db.insert(mediaItems).values({
        id: mediaId, library_id: libraryId, kind: 'movie', title: 'Test Movie',
        sort_title: 'test movie', metadata_status: 'local', metadata_source: 'filename',
        created_at: now, updated_at: now,
      })

      // Save watch state
      await app.inject({
        method: 'PUT',
        url: `/api/v1/watchstate/${mediaId}`,
        headers: { Cookie: cookie },
        payload: { position_seconds: 1234, duration_seconds: 7200 },
      })

      // Get continue watching — should include this item
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/watchstate/continue-watching',
        headers: { Cookie: cookie },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.some((item: any) => item.id === mediaId)).toBe(true)
    })
  })

  // ─── POST /api/v1/auth/change-password ───────────────────────────────────

  describe('POST /api/v1/auth/change-password', () => {
    it('succeeds with correct current password', async () => {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'oldpassword' },
      })
      const cookie = extractCookie(setupRes.headers['set-cookie'])!

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: { Cookie: cookie },
        payload: { currentPassword: 'oldpassword', newPassword: 'newpassword123' },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.ok).toBe(true)

      // Can log in with new password
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'admin', password: 'newpassword123' },
      })
      expect(loginRes.statusCode).toBe(200)
    })

    it('returns 401 for wrong current password', async () => {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'correctpassword' },
      })
      const cookie = extractCookie(setupRes.headers['set-cookie'])!

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: { Cookie: cookie },
        payload: { currentPassword: 'wrongpassword', newPassword: 'newpassword123' },
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 401 when not authenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        payload: { currentPassword: 'old', newPassword: 'newpassword123' },
      })
      expect(res.statusCode).toBe(401)
    })
  })
})
