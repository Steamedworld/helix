/**
 * User management API tests — Phase 8.
 *
 * Tests cover:
 * - GET /api/v1/users  (admin only)
 * - POST /api/v1/users  (admin creates users; non-admin → 403)
 * - PATCH /api/v1/users/:id  (admin updates role / displayName / disabled)
 * - DELETE /api/v1/users/:id  (soft-disable + session revocation)
 * - POST /api/v1/users/:id/reset-password  (admin resets password)
 * - Responses never contain password_hash
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { users } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { hashPassword } from '../src/services/auth/password'
import { COOKIE_NAME } from '../src/middleware/auth'
import { setupAuth } from './helpers/auth'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

/** Extract the raw cookie string from a Set-Cookie header */
function extractCookie(setCookieHeader: string | string[] | undefined): string | null {
  if (!setCookieHeader) return null
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader
  const match = raw.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  return match ? `${COOKIE_NAME}=${match[1]}` : null
}

/** Create a regular (non-admin) user directly in the DB and return a session cookie for it */
async function createUserAndLogin(
  app: ReturnType<typeof buildServer>,
  db: TestDb,
  username: string,
  password: string,
  role: 'user' | 'admin' = 'user',
): Promise<string> {
  const passwordHash = await hashPassword(password)
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await db.insert(users).values({
    id,
    display_name: username,
    role,
    username,
    password_hash: passwordHash,
    disabled: 0,
    created_at: now,
    updated_at: now,
  })

  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(loginRes.statusCode).toBe(200)
  const cookie = extractCookie(loginRes.headers['set-cookie'])
  expect(cookie).not.toBeNull()
  return cookie!
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('user management API', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-usermgmt-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    const localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId)
    await app.ready()
    // Sets up the admin user (testadmin / testpassword123) via /auth/setup
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  // ─── GET /api/v1/users ─────────────────────────────────────────────────────

  describe('GET /api/v1/users', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/users' })
      expect(res.statusCode).toBe(401)
    })

    it('returns 403 for a regular user', async () => {
      const userCookie = await createUserAndLogin(app, db, 'regularuser', 'password123')
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users',
        headers: { Cookie: userCookie },
      })
      expect(res.statusCode).toBe(403)
    })

    it('returns list of users for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users',
        headers: { Cookie: adminCookie },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(Array.isArray(body.data)).toBe(true)
      expect(body.data.length).toBeGreaterThanOrEqual(1)
    })

    it('never returns password_hash in list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users',
        headers: { Cookie: adminCookie },
      })
      const body = JSON.parse(res.body)
      for (const u of body.data) {
        expect(u).not.toHaveProperty('password_hash')
      }
    })

    it('returned users include id, username, role, display_name, disabled', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users',
        headers: { Cookie: adminCookie },
      })
      const body = JSON.parse(res.body)
      const admin = body.data[0]
      expect(admin).toHaveProperty('id')
      expect(admin).toHaveProperty('username')
      expect(admin).toHaveProperty('role')
      expect(admin).toHaveProperty('display_name')
      expect(typeof admin.disabled).toBe('number')
    })
  })

  // ─── POST /api/v1/users ────────────────────────────────────────────────────

  describe('POST /api/v1/users', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'newuser', password: 'password123' }),
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 403 for non-admin user', async () => {
      const userCookie = await createUserAndLogin(app, db, 'notadmin', 'password123')
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: userCookie },
        body: JSON.stringify({ username: 'newuser2', password: 'password123' }),
      })
      expect(res.statusCode).toBe(403)
    })

    it('admin can create a new user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'newuser', password: 'password123' }),
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data.username).toBe('newuser')
      expect(body.data.role).toBe('user')
    })

    it('response never contains password_hash', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'securenewuser', password: 'password123' }),
      })
      const body = JSON.parse(res.body)
      expect(body.data).not.toHaveProperty('password_hash')
    })

    it('can create user with admin role', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'secondadmin', password: 'adminpass123', role: 'admin' }),
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.data.role).toBe('admin')
    })

    it('can create user with custom displayName', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'jdoe', password: 'password123', displayName: 'John Doe' }),
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.data.display_name).toBe('John Doe')
    })

    it('returns 409 for duplicate username', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'dupuser', password: 'password123' }),
      })
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'dupuser', password: 'differentpassword' }),
      })
      expect(res.statusCode).toBe(409)
    })

    it('returns 400 for invalid username (too short)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'ab', password: 'password123' }),
      })
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 for password shorter than 8 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'validuser', password: 'short' }),
      })
      expect(res.statusCode).toBe(400)
    })

    it('created user can log in with their credentials', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'logintest', password: 'mypassword123' }),
      })

      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'logintest', password: 'mypassword123' }),
      })
      expect(loginRes.statusCode).toBe(200)
    })
  })

  // ─── PATCH /api/v1/users/:id ───────────────────────────────────────────────

  describe('PATCH /api/v1/users/:id', () => {
    it('returns 401 when not authenticated', async () => {
      const [adminUser] = await db.select().from(users).limit(1)
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${adminUser.id}`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Hacker' }),
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 403 for non-admin user', async () => {
      const userCookie = await createUserAndLogin(app, db, 'patchtest', 'password123')
      const [adminUser] = await db.select().from(users).limit(1)
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${adminUser.id}`,
        headers: { 'Content-Type': 'application/json', Cookie: userCookie },
        body: JSON.stringify({ displayName: 'Hacker' }),
      })
      expect(res.statusCode).toBe(403)
    })

    it('admin can update displayName', async () => {
      // Create a user to update
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'updateme', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${userId}`,
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ displayName: 'Updated Name' }),
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.display_name).toBe('Updated Name')
    })

    it('admin can promote user to admin role', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'promoteme', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${userId}`,
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'admin' }),
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.role).toBe('admin')
    })

    it('admin can disable a user', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'disableme', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${userId}`,
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ disabled: true }),
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.disabled).toBe(1)
    })

    it('disabled user cannot log in', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'soonblocked', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      // Disable the user
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${userId}`,
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ disabled: true }),
      })

      // Try to log in
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'soonblocked', password: 'password123' }),
      })
      expect(loginRes.statusCode).toBe(403)
    })

    it('response never contains password_hash', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'nohash', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${userId}`,
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ displayName: 'No Hash' }),
      })
      const body = JSON.parse(res.body)
      expect(body.data).not.toHaveProperty('password_hash')
    })

    it('returns 404 for unknown user id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/nonexistent-id',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ displayName: 'Ghost' }),
      })
      expect(res.statusCode).toBe(404)
    })
  })

  // ─── DELETE /api/v1/users/:id ──────────────────────────────────────────────

  describe('DELETE /api/v1/users/:id', () => {
    it('returns 401 when not authenticated', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'todel401', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id
      const res = await app.inject({ method: 'DELETE', url: `/api/v1/users/${userId}` })
      expect(res.statusCode).toBe(401)
    })

    it('returns 403 for non-admin', async () => {
      const userCookie = await createUserAndLogin(app, db, 'cannotdelete', 'password123')
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'todel403', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${userId}`,
        headers: { Cookie: userCookie },
      })
      expect(res.statusCode).toBe(403)
    })

    it('soft-disables the user (does not hard delete)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'softdel', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${userId}`,
        headers: { Cookie: adminCookie },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.disabled).toBe(true)

      // User still exists in DB
      const [dbUser] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
      expect(dbUser).toBeDefined()
      expect(dbUser.disabled).toBe(1)
    })

    it('invalidates active sessions after deletion', async () => {
      // Create and log in as a new user
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'tokillsession', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'tokillsession', password: 'password123' }),
      })
      const userCookie = extractCookie(loginRes.headers['set-cookie'])!

      // Confirm cookie works before deletion
      const meBefore = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { Cookie: userCookie },
      })
      expect(meBefore.statusCode).toBe(200)

      // Admin deletes the user
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${userId}`,
        headers: { Cookie: adminCookie },
      })

      // Session should now be invalid
      const meAfter = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { Cookie: userCookie },
      })
      expect(meAfter.statusCode).toBe(401)
    })

    it('returns 404 for unknown user id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/users/nonexistent-id',
        headers: { Cookie: adminCookie },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  // ─── POST /api/v1/users/:id/reset-password ────────────────────────────────

  describe('POST /api/v1/users/:id/reset-password', () => {
    it('returns 401 when not authenticated', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'resetme401', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/users/${userId}/reset-password`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'newpassword123' }),
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 403 for non-admin', async () => {
      const userCookie = await createUserAndLogin(app, db, 'cannotreset', 'password123')
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'resetme403', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/users/${userId}/reset-password`,
        headers: { 'Content-Type': 'application/json', Cookie: userCookie },
        body: JSON.stringify({ password: 'newpassword123' }),
      })
      expect(res.statusCode).toBe(403)
    })

    it('admin can reset password and new password works', async () => {
      // Create user and log in to get a session
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'passreset', password: 'oldpassword123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      // Reset password
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/users/${userId}/reset-password`,
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ password: 'brandnewpass456' }),
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)

      // Old password should no longer work
      const oldLoginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'passreset', password: 'oldpassword123' }),
      })
      expect(oldLoginRes.statusCode).toBe(401)

      // New password should work
      const newLoginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'passreset', password: 'brandnewpass456' }),
      })
      expect(newLoginRes.statusCode).toBe(200)
    })

    it('reset-password revokes existing sessions', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'sessionkill', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      // Log in as this user
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sessionkill', password: 'password123' }),
      })
      const userCookie = extractCookie(loginRes.headers['set-cookie'])!

      // Confirm session is active
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { Cookie: userCookie },
      })
      expect(meRes.statusCode).toBe(200)

      // Admin resets password
      await app.inject({
        method: 'POST',
        url: `/api/v1/users/${userId}/reset-password`,
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ password: 'freshpassword123' }),
      })

      // Old session should be revoked
      const meAfterRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { Cookie: userCookie },
      })
      expect(meAfterRes.statusCode).toBe(401)
    })

    it('returns 400 for password shorter than 8 characters', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'shortpassreset', password: 'password123' }),
      })
      const userId = JSON.parse(createRes.body).data.id

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/users/${userId}/reset-password`,
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ password: 'tiny' }),
      })
      expect(res.statusCode).toBe(400)
    })

    it('returns 404 for unknown user id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users/nonexistent/reset-password',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ password: 'newpassword123' }),
      })
      expect(res.statusCode).toBe(404)
    })
  })
})
