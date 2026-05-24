import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { hashPassword } from '../services/auth/password'
import { revokeAllUserSessions } from '../services/auth/sessions'
import { makeRequireAdmin } from '../middleware/auth'

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,32}$/

function sanitizeUser(user: typeof users.$inferSelect) {
  // Never return password_hash
  const { password_hash: _ph, ...rest } = user
  return rest
}

export async function userRoutes(app: FastifyInstance, opts: { db: DrizzleDB }) {
  const { db } = opts
  const requireAdmin = makeRequireAdmin(db)

  // GET /api/v1/users
  app.get('/', { preHandler: requireAdmin }, async () => {
    const allUsers = await db.select().from(users)
    return ok(allUsers.map(sanitizeUser))
  })

  // POST /api/v1/users
  app.post<{
    Body: {
      username: string
      password: string
      role?: 'admin' | 'user'
      displayName?: string
    }
  }>('/', { preHandler: requireAdmin }, async (req, reply) => {
    const { username, password, role = 'user', displayName } = req.body ?? {}

    if (!username || !USERNAME_REGEX.test(username)) {
      reply.status(400)
      return err('Username must be 3-32 chars and contain only letters, numbers, underscores, or hyphens')
    }
    if (!password || password.length < 8) {
      reply.status(400)
      return err('Password must be at least 8 characters')
    }

    const [existing] = await db.select().from(users).where(eq(users.username, username)).limit(1)
    if (existing) {
      reply.status(409)
      return err('Username already taken')
    }

    const passwordHash = await hashPassword(password)
    const now = new Date().toISOString()
    const id = crypto.randomUUID()

    await db.insert(users).values({
      id,
      display_name: displayName ?? username,
      role,
      username,
      password_hash: passwordHash,
      disabled: 0,
      created_at: now,
      updated_at: now,
    })

    const [created] = await db.select().from(users).where(eq(users.id, id)).limit(1)
    reply.status(201)
    return ok(sanitizeUser(created))
  })

  // PATCH /api/v1/users/:id
  app.patch<{
    Params: { id: string }
    Body: {
      role?: 'admin' | 'user'
      displayName?: string
      disabled?: boolean
    }
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const [user] = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1)
    if (!user) {
      reply.status(404)
      return err('User not found')
    }

    const { role, displayName, disabled } = req.body ?? {}
    const updates: Partial<typeof users.$inferInsert> = {
      updated_at: new Date().toISOString(),
    }
    if (role !== undefined) updates.role = role
    if (displayName !== undefined) updates.display_name = displayName
    if (disabled !== undefined) updates.disabled = disabled ? 1 : 0

    await db.update(users).set(updates).where(eq(users.id, req.params.id))

    const [updated] = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1)
    return ok(sanitizeUser(updated))
  })

  // DELETE /api/v1/users/:id — disable, not hard delete
  app.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const [user] = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1)
    if (!user) {
      reply.status(404)
      return err('User not found')
    }

    await db.update(users).set({
      disabled: 1,
      updated_at: new Date().toISOString(),
    }).where(eq(users.id, req.params.id))

    // Revoke all active sessions for this user
    await revokeAllUserSessions(db, req.params.id)

    return ok({ disabled: true })
  })

  // POST /api/v1/users/:id/reset-password
  app.post<{
    Params: { id: string }
    Body: { password: string }
  }>('/:id/reset-password', { preHandler: requireAdmin }, async (req, reply) => {
    const { password } = req.body ?? {}

    if (!password || password.length < 8) {
      reply.status(400)
      return err('Password must be at least 8 characters')
    }

    const [user] = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1)
    if (!user) {
      reply.status(404)
      return err('User not found')
    }

    const passwordHash = await hashPassword(password)
    await db.update(users).set({
      password_hash: passwordHash,
      updated_at: new Date().toISOString(),
    }).where(eq(users.id, req.params.id))

    // Revoke all active sessions
    await revokeAllUserSessions(db, req.params.id)

    return ok({ ok: true })
  })
}
