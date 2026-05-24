import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { hashPassword, verifyPassword } from '../services/auth/password'
import {
  createSession,
  revokeSession,
  revokeAllUserSessions,
  revokeAllUserSessionsExcept,
} from '../services/auth/sessions'
import { getCurrentUser, COOKIE_NAME, makeRequireAuth } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,32}$/

function cookieOpts(isProduction: boolean): object {
  return {
    httpOnly: true,
    path: '/',
    sameSite: 'strict' as const,
    secure: isProduction,
    maxAge: 30 * 24 * 60 * 60, // 30 days in seconds
  }
}

export async function authRoutes(app: FastifyInstance, opts: { db: DrizzleDB }) {
  const { db } = opts
  const isProduction = process.env.NODE_ENV === 'production'
  const requireAuth = makeRequireAuth(db)

  // GET /api/v1/auth/status
  app.get('/status', async (req) => {
    // setupRequired = true if no user has a password_hash
    const allUsers = await db.select().from(users)
    const setupRequired = allUsers.every((u) => !u.password_hash)

    const result = await getCurrentUser(req, db)

    return ok({
      setupRequired,
      authenticated: !!result,
      user: result
        ? ({
            id: result.user.id,
            username: result.user.username,
            displayName: result.user.displayName,
            role: result.user.role,
          } as AuthUser)
        : null,
    })
  })

  // POST /api/v1/auth/setup
  app.post<{
    Body: { username: string; password: string; displayName?: string }
  }>('/setup', async (req, reply) => {
    const { username, password, displayName } = req.body ?? {}

    // Check if setup is still needed
    const allUsers = await db.select().from(users)
    const setupRequired = allUsers.every((u) => !u.password_hash)
    if (!setupRequired) {
      reply.status(409)
      return err('Setup already complete')
    }

    // Validate
    if (!username || !USERNAME_REGEX.test(username)) {
      reply.status(400)
      return err('Username must be 3-32 chars and contain only letters, numbers, underscores, or hyphens')
    }
    if (!password || password.length < 8) {
      reply.status(400)
      return err('Password must be at least 8 characters')
    }

    // Check username uniqueness
    const [existing] = await db.select().from(users).where(eq(users.username, username)).limit(1)
    if (existing) {
      reply.status(409)
      return err('Username already taken')
    }

    // Use first user (the bootstrapped admin) or create new
    const passwordHash = await hashPassword(password)
    const now = new Date().toISOString()

    let userId: string

    // There should be at least one user from bootstrap — update them
    if (allUsers.length > 0) {
      const firstUser = allUsers[0]
      userId = firstUser.id
      await db.update(users).set({
        username,
        password_hash: passwordHash,
        display_name: displayName ?? firstUser.display_name,
        updated_at: now,
      }).where(eq(users.id, firstUser.id))
    } else {
      // Shouldn't normally happen (bootstrap creates a user), but handle it
      userId = crypto.randomUUID()
      await db.insert(users).values({
        id: userId,
        display_name: displayName ?? username,
        role: 'admin',
        username,
        password_hash: passwordHash,
        disabled: 0,
        created_at: now,
        updated_at: now,
      })
    }

    const [updatedUser] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!updatedUser || !updatedUser.username) {
      reply.status(500)
      return err('Setup failed')
    }

    const rawToken = await createSession(db, userId, req.headers['user-agent'])
    reply.setCookie(COOKIE_NAME, rawToken, cookieOpts(isProduction))

    return ok({
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        displayName: updatedUser.display_name,
        role: updatedUser.role,
      } as AuthUser,
    })
  })

  // POST /api/v1/auth/login
  app.post<{
    Body: { username: string; password: string }
  }>('/login', async (req, reply) => {
    const { username, password } = req.body ?? {}

    if (!username || !password) {
      reply.status(401)
      return err('Invalid credentials')
    }

    const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1)

    // Generic error: don't reveal whether username exists
    if (!user || !user.password_hash) {
      reply.status(401)
      return err('Invalid credentials')
    }

    if (user.disabled !== 0) {
      reply.status(403)
      return err('Account is disabled')
    }

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) {
      reply.status(401)
      return err('Invalid credentials')
    }

    const rawToken = await createSession(db, user.id, req.headers['user-agent'])
    reply.setCookie(COOKIE_NAME, rawToken, cookieOpts(isProduction))

    return ok({
      user: {
        id: user.id,
        username: user.username!,
        displayName: user.display_name,
        role: user.role,
      } as AuthUser,
    })
  })

  // POST /api/v1/auth/logout — requires auth
  app.post('/logout', { preHandler: requireAuth }, async (req, reply) => {
    if (req.sessionId) {
      await revokeSession(db, req.sessionId)
    }
    reply.clearCookie(COOKIE_NAME, { path: '/' })
    return ok({ ok: true })
  })

  // GET /api/v1/auth/me — requires auth
  app.get('/me', { preHandler: requireAuth }, async (req) => {
    return ok({ user: req.user! })
  })

  // POST /api/v1/auth/change-password — requires auth
  app.post<{
    Body: { currentPassword: string; newPassword: string }
  }>('/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body ?? {}

    if (!currentPassword || !newPassword) {
      reply.status(400)
      return err('currentPassword and newPassword are required')
    }
    if (newPassword.length < 8) {
      reply.status(400)
      return err('New password must be at least 8 characters')
    }

    const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1)
    if (!user || !user.password_hash) {
      reply.status(400)
      return err('No password set for this account')
    }

    const valid = await verifyPassword(currentPassword, user.password_hash)
    if (!valid) {
      reply.status(401)
      return err('Current password is incorrect')
    }

    const newHash = await hashPassword(newPassword)
    await db.update(users).set({
      password_hash: newHash,
      updated_at: new Date().toISOString(),
    }).where(eq(users.id, user.id))

    // Revoke all other sessions
    if (req.sessionId) {
      await revokeAllUserSessionsExcept(db, user.id, req.sessionId)
    }

    return ok({ ok: true })
  })
}
