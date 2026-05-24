import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { mediaItems } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { metadataRegistry } from '../services/metadata/registry'
import { scoreCandidate } from '../services/metadata/scoring'
import { enrichBatch, enrichMediaItem, applyMatch } from '../services/metadata/enrichment'
import type { ProviderInfo, MetadataCandidate } from '../services/metadata/types'

// ─── Collection-level metadata routes (/api/v1/metadata/...) ───────────────────

export async function metadataCollectionRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB }
) {
  const { db } = opts

  // GET /api/v1/metadata/providers
  app.get('/providers', async () => {
    const providers: ProviderInfo[] = metadataRegistry.listProviders()
    return ok({ providers })
  })

  // POST /api/v1/metadata/enrich — bulk enrich up to 20 items
  app.post<{ Body: { limit?: number } }>('/enrich', async (req) => {
    const limit = Math.min(req.body?.limit ?? 20, 20)
    const results = await enrichBatch(db, limit)
    return ok({ results, count: results.length })
  })
}

// ─── Per-item metadata routes (/api/v1/media/:id/metadata/...) ─────────────────

export async function metadataItemRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB }
) {
  const { db } = opts

  // POST /media/:id/metadata/refresh — force re-enrich single item
  app.post<{ Params: { id: string } }>('/:id/metadata/refresh', async (req, reply) => {
    const { id } = req.params

    const [item] = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.id, id))

    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    const result = await enrichMediaItem(db, id, { force: true })
    return ok(result)
  })

  // GET /media/:id/metadata/search — search providers for candidates
  app.get<{ Params: { id: string } }>('/:id/metadata/search', async (req, reply) => {
    const { id } = req.params

    const [item] = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.id, id))

    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    const providers = metadataRegistry.getEnabledProvidersForKind(item.kind as any)
    if (providers.length === 0) {
      return ok({ candidates: [] })
    }

    const query = { title: item.title, year: item.year ?? undefined }
    const allCandidates: MetadataCandidate[] = []

    for (const provider of providers) {
      try {
        const rawCandidates = await provider.searchMovies(item.title, item.year ?? undefined)
        for (const candidate of rawCandidates) {
          const score = scoreCandidate(candidate, query)
          allCandidates.push({ ...candidate, score })
        }
      } catch {
        // Provider error — skip, return what we have
      }
    }

    // Sort by descending score
    allCandidates.sort((a, b) => b.score - a.score)

    return ok({ candidates: allCandidates })
  })

  // POST /media/:id/metadata/match — select a specific candidate
  app.post<{
    Params: { id: string }
    Body: { providerId: string; externalId: string }
  }>('/:id/metadata/match', async (req, reply) => {
    const { id } = req.params
    const { providerId, externalId } = req.body ?? {}

    if (!providerId || !externalId) {
      reply.status(400)
      return err('providerId and externalId are required')
    }

    const [item] = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.id, id))

    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    const result = await applyMatch(db, id, providerId, externalId)

    if (result.status === 'error') {
      reply.status(500)
      return err(result.error ?? 'Enrichment failed')
    }

    // Return updated media item
    const [updated] = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.id, id))

    return ok({ result, item: updated })
  })
}
