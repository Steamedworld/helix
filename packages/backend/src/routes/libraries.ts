import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { libraries, mediaItems } from '../db/schema'
import { ok, err } from '../lib/response'
import { scanLibrary } from '../services/scanner'
import type { DrizzleDB } from '../db/client'
import type { LibraryKind } from '@helix/shared'
import { count } from 'drizzle-orm'
import { makeRequireAdmin } from '../middleware/auth'

export async function libraryRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId: string }
) {
  const { db, localNodeId } = opts
  const requireAdmin = makeRequireAdmin(db)

  // GET /libraries
  app.get('/', async () => {
    const rows = await db.select().from(libraries)
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
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const [lib] = await db.select().from(libraries).where(eq(libraries.id, req.params.id))
    if (!lib) {
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

    // Set scan status to scanning
    const now = new Date().toISOString()
    await db
      .update(libraries)
      .set({ scan_status: 'scanning', updated_at: now })
      .where(eq(libraries.id, lib.id))

    // Run scan async
    const libraryForScan = { ...lib, scan_status: 'scanning' as const }
    scanLibrary(libraryForScan, localNodeId, db)
      .then(async () => {
        const done = new Date().toISOString()
        await db
          .update(libraries)
          .set({ scan_status: 'idle', updated_at: done })
          .where(eq(libraries.id, lib.id))
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
  app.get<{ Params: { id: string } }>('/:id/scan-status', async (req, reply) => {
    const [lib] = await db.select().from(libraries).where(eq(libraries.id, req.params.id))
    if (!lib) {
      reply.status(404)
      return err('Library not found')
    }
    const [{ item_count }] = await db
      .select({ item_count: count() })
      .from(mediaItems)
      .where(eq(mediaItems.library_id, lib.id))

    return ok({ scan_status: lib.scan_status, item_count })
  })
}
