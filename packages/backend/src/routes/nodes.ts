import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { nodes } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'

export async function nodeRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB }
) {
  const { db } = opts

  // GET /nodes
  app.get('/', async () => {
    const rows = await db.select().from(nodes)
    return ok(rows)
  })

  // GET /nodes/:id
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
    if (!node) {
      reply.status(404)
      return err('Node not found')
    }
    return ok(node)
  })
}
