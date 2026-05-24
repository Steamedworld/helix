import { createHash, randomBytes } from 'crypto'
import { eq, and, lt, isNull, or } from 'drizzle-orm'
import { sessions, users } from '../../db/schema'
import type { DrizzleDB } from '../../db/client'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(
  db: DrizzleDB,
  userId: string,
  userAgent?: string
): Promise<string> {
  const rawToken = generateToken()
  const tokenHash = hashToken(rawToken)
  const now = Date.now()
  const id = crypto.randomUUID()

  await db.insert(sessions).values({
    id,
    user_id: userId,
    token_hash: tokenHash,
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
    last_seen_at: now,
    user_agent: userAgent ?? null,
    revoked_at: null,
  })

  return rawToken
}

export async function validateSession(
  db: DrizzleDB,
  rawToken: string
): Promise<{ userId: string; sessionId: string } | null> {
  const tokenHash = hashToken(rawToken)
  const now = Date.now()

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.token_hash, tokenHash))
    .limit(1)

  if (!session) return null
  if (session.revoked_at !== null) return null
  if (session.expires_at < now) return null

  // Update last_seen_at
  await db
    .update(sessions)
    .set({ last_seen_at: now })
    .where(eq(sessions.id, session.id))

  return { userId: session.user_id, sessionId: session.id }
}

export async function revokeSession(db: DrizzleDB, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revoked_at: Date.now() })
    .where(eq(sessions.id, sessionId))
}

export async function revokeAllUserSessions(db: DrizzleDB, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revoked_at: Date.now() })
    .where(and(eq(sessions.user_id, userId), isNull(sessions.revoked_at)))
}

export async function revokeAllUserSessionsExcept(
  db: DrizzleDB,
  userId: string,
  sessionId: string
): Promise<void> {
  const now = Date.now()
  const allSessions = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.user_id, userId), isNull(sessions.revoked_at)))

  for (const s of allSessions) {
    if (s.id !== sessionId) {
      await db.update(sessions).set({ revoked_at: now }).where(eq(sessions.id, s.id))
    }
  }
}

export async function cleanExpiredSessions(db: DrizzleDB): Promise<void> {
  const now = Date.now()
  await db.delete(sessions).where(lt(sessions.expires_at, now))
}
