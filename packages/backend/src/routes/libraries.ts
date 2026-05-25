import type { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { libraries, mediaItems, libraryPermissions, users } from '../db/schema'
import { ok, err } from '../lib/response'
import { scanLibrary } from '../services/scanner'
import type { DrizzleDB } from '../db/client'
import type { LibraryKind } from '@helix/shared'
import { count } from 'drizzle-orm'
import { makeRequireAdmin, makeRequireAuth } from '../middleware/auth'
import { enrichmentQueue } from '../services/enrichmentQueue'
import { canViewLibrary, filterLibrariesForUser } from '../lib/permissions'

export async function libraryRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId: string }
) {
  const { db, localNodeId } = opts
  const requireAdmin = makeRequireAdmin(db)
  const requireAuth = makeRequireAuth(db)

  // GET /libraries
  app.get('/', { preHandler: requireAuth }, async (req) => {
    const user = req.user!
    const rows = await filterLibrariesForUser(user, db)
    return ok(rows)
  })

  // POST /libraries
  app.post<{
    Body: { name: string; kind: LibraryKind; root_path: string }
  }>('/', { preHandler: requireAdmin }, async (req, reply) => {
    const { name, kind, root_path } = req.body
    if (!name || !kind || !root_path) {
      reply.status(400)
      return err('name, kind, and root_path are required')
    }
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(libraries).values({
      id,
      node_id: localNodeId,
      name,
      kind,
      root_path,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })
    const [created] = await db.select().from(libraries).where(eq(libraries.id, id))
    reply.status(201)
    return ok(created)
  })

  // GET /libraries/:id
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!
    const [lib] = await db.select().from(libraries).where(eq(libraries.id, req.params.id))
    if (!lib) {
      reply.status(404)
      return err('Library not found')
    }
    if (!await canViewLibrary(user, lib.id, db)) {
      reply.status(404)
      return err('Library not found')
    }
    return ok(lib)
  })

  // PUT /libraries/:id
  app.put<{
    Params: { id: string }
    Body: Partial<{ name: string; kind: LibraryKind; root_path: string }>
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const [existing] = await db.select().from(libraries).where(eq(libraries.id, req.params.id))
    if (!existing) {
      reply.status(404)
      return err('Library not found')
    }
    const now = new Date().toISOString()
    await db
      .update(libraries)
      .set({ ...req.body, updated_at: now })
      .where(eq(libraries.id, req.params.id))
    const [updated] = await db.select().from(libraries).where(eq(libraries.id, req.params.id))
    return ok(updated)
  })

  // DELETE /libraries/:id
  app.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const [existing] = await db.select().from(libraries).where(eq(libraries.id, req.params.id))
    if (!existing) {
      reply.status(404)
      return err('Library not found')
    }
    await db.delete(libraries).where(eq(libraries.id, req.params.id))
    return ok({ deleted: true })
  })

  // POST /libraries/:id/scan
  app.post<{ Params: { id: string } }>('/:id/scan', { preHandler: requireAdmin }, async (req, reply) => {
    const [lib] = await db.select().from(libraries).where(eq(libraries.id, req.params.id))
    if (!lib) {
      reply.status(404)
      return err('Library not found')
    }

    const now = new Date().toISOString()
    await db
      .update(libraries)
      .set({ scan_status: 'scanning', updated_at: now })
      .where(eq(libraries.id, lib.id))

    const libraryForScan = { ...lib, scan_status: 'scanning' as const }
    scanLibrary(libraryForScan, localNodeId, db)
      .then(async () => {
        const done = new Date().toISOString()
        await db
          .update(libraries)
          .set({ scan_status: 'idle', updated_at: done })
          .where(eq(libraries.id, lib.id))
        enrichmentQueue.enqueueLibraryItems(db, lib.id).catch(() => {})
      })
      .catch(async () => {
        const done = new Date().toISOString()
        await db
          .update(libraries)
          .set({ scan_status: 'error', updated_at: done })
          .where(eq(libraries.id, lib.id))
      })

    return ok({ started: true })
  })

  // GET /libraries/:id/scan-status
  app.get<{ Params: { id: string } }>('/:id/scan-status', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!
    const [lib] = await db.select().from(libraries).where(eq(libraries.id, req.params.id))
    if (!lib) {
      reply.status(404)
      return err('Library not found')
    }
    if (!await canViewLibrary(user, lib.id, db)) {
      reply.status(404)
      return err('Library not found')
    }
    const [{ item_count }] = await db
      .select({ item_count: count() })
      .from(mediaItems)
      .where(eq(mediaItems.library_id, lib.id))

    return ok({ scan_status: lib.scan_status, item_count })
  })

  // ─── Library permission management (admin only) ─────────────────────────────

  // GET /libraries/:id/permissions — list all user permissions for a library
  app.get<{ Params: { id: string } }>('/:id/permissions', { preHandler: requireAdmin }, async (req, reply) => {
    const [lib] = await db.select().from(libraries).where(eq(libraries.id, req.params.id))
    if (!lib) {
      reply.status(404)
      return err('Library not found')
    }

    const perms = await db
      .select({
        id: libraryPermissions.id,
        library_id: libraryPermissions.library_id,
        user_id: libraryPermissions.user_id,
        can_view: libraryPermissions.can_view,
        can_play: libraryPermissions.can_play,
        created_at: libraryPermissions.created_at,
        updated_at: libraryPermissions.updated_at,
        username: users.username,
        display_name: users.display_name,
      })
      .from(libraryPermissions)
      .innerJoin(users, eq(libraryPermissions.user_id, users.id))
      .where(eq(libraryPermissions.library_id, req.params.id))

    return ok(perms)
  })

  // PUT /libraries/:id/permissions/:userId — set or update permissions for a user
  app.put<{
    Params: { id: string; userId: string }
    Body: { can_view?: boolean; can_play?: boolean }
  }>('/:id/permissions/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const { id: libraryId, userId } = req.params
    const { can_view = true, can_play = true } = req.body ?? {}

    const [lib] = await db.select().from(libraries).where(eq(libraries.id, libraryId))
    if (!lib) {
      reply.status(404)
      return err('Library not found')
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!user) {
      reply.status(404)
      return err('User not found')
    }

    if (user.role === 'admin') {
      reply.status(400)
      return err('Admin users always have full access — no permission grant needed')
    }

    const [existing] = await db
      .select()
      .from(libraryPermissions)
      .where(and(eq(libraryPermissions.library_id, libraryId), eq(libraryPermissions.user_id, userId)))
      .limit(1)

    const now = new Date().toISOString()

    if (existing) {
      await db
        .update(libraryPermissions)
        .set({ can_view, can_play, updated_at: now })
        .where(eq(libraryPermissions.id, existing.id))
    } else {
      await db.insert(libraryPermissions).values({
        id: crypto.randomUUID(),
        library_id: libraryId,
        user_id: userId,
        can_view,
        can_play,
        created_at: now,
        updated_at: now,
      })
    }

    const [perm] = await db
      .select()
      .from(libraryPermissions)
      .where(and(eq(libraryPermissions.library_id, libraryId), eq(libraryPermissions.user_id, userId)))
      .limit(1)

    return ok(perm)
  })

  // DELETE /libraries/:id/permissions/:userId — remove permissions for a user
  app.delete<{ Params: { id: string; userId: string } }>(
    '/:id/permissions/:userId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id: libraryId, userId } = req.params

      const [existing] = await db
        .select()
        .from(libraryPermissions)
        .where(and(eq(libraryPermissions.library_id, libraryId), eq(libraryPermissions.user_id, userId)))
        .limit(1)

      if (!existing) {
        reply.status(404)
        return err('Permission not found')
      }

      await db.delete(libraryPermissions).where(eq(libraryPermissions.id, existing.id))
      return ok({ deleted: true })
    }
  )
}
