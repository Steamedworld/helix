import type { FastifyRequest, FastifyReply } from 'fastify'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { validateSession } from '../services/auth/sessions'
import type { DrizzleDB } from '../db/client'

export interface AuthUser {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'user'
}

// Extend FastifyRequest to include user
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
    sessionId?: string
  }
}

export const COOKIE_NAME = 'helix_session'

export async function getCurrentUser(
  request: FastifyRequest,
  db: DrizzleDB
): Promise<{ user: AuthUser; sessionId: string } | null> {
  const rawToken = request.cookies?.[COOKIE_NAME]
  if (!rawToken) return null

  const result = await validateSession(db, rawToken)
  if (!result) return null

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, result.userId))
    .limit(1)

  if (!user || user.disabled !== 0) return null
  if (!user.username) return null

  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
    },
    sessionId: result.sessionId,
  }
}

export function makeRequireAuth(db: DrizzleDB) {
  return async function requireAuth(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const result = await getCurrentUser(request, db)
    if (!result) {
      reply.status(401).send({ ok: false, error: 'Authentication required' })
      return
    }
    request.user = result.user
    request.sessionId = result.sessionId
  }
}

export function makeRequireAdmin(db: DrizzleDB) {
  return async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const result = await getCurrentUser(request, db)
    if (!result) {
      reply.status(401).send({ ok: false, error: 'Authentication required' })
      return
    }
    if (result.user.role !== 'admin') {
      reply.status(403).send({ ok: false, error: 'Admin access required' })
      return
    }
    request.user = result.user
    request.sessionId = result.sessionId
  }
}
