import type { FastifyInstance } from 'fastify'
import { eq, and, inArray } from 'drizzle-orm'
import { watchStates, mediaItems } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { sql } from 'drizzle-orm'
import { makeRequireAuth } from '../middleware/auth'
import { canViewLibrary, getViewableLibraryIds } from '../lib/permissions'

export async function watchStateRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB }
) {
  const { db } = opts
  const requireAuth = makeRequireAuth(db)

  // PUT /watchstate/:media_item_id
  app.put<{
    Params: { media_item_id: string }
    Body: {
      position_seconds: number
      duration_seconds?: number
      completed?: boolean
    }
  }>('/:media_item_id', { preHandler: requireAuth }, async (req, reply) => {
    const { position_seconds, duration_seconds, completed } = req.body
    const user = req.user!

    if (position_seconds === undefined) {
      reply.status(400)
      return err('position_seconds is required')
    }

    const mediaItemId = req.params.media_item_id

    // Check the item exists and user can view it
    const [item] = await db
      .select({ library_id: mediaItems.library_id })
      .from(mediaItems)
      .where(eq(mediaItems.id, mediaItemId))
      .limit(1)

    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    if (!await canViewLibrary(user, item.library_id, db)) {
      reply.status(404)
      return err('Media item not found')
    }

    const now = new Date().toISOString()

    // Check if a watch state already exists
    const [existing] = await db
      .select()
      .from(watchStates)
      .where(
        and(
          eq(watchStates.user_id, user.id),
          eq(watchStates.media_item_id, mediaItemId)
        )
      )
      .limit(1)

    if (existing) {
      // Completion protection: never un-complete a previously completed item
      // unless the caller explicitly requests completed=false AND the position
      // is before the halfway mark (i.e. a deliberate rewatch from the start).
      let resolvedCompleted: boolean
      if (existing.completed) {
        const dur = duration_seconds ?? existing.duration_seconds ?? 0
        const halfwayPoint = dur > 0 ? dur * 0.5 : Infinity
        if (completed === false && position_seconds < halfwayPoint) {
          resolvedCompleted = false
        } else {
          resolvedCompleted = true
        }
      } else {
        resolvedCompleted = completed ?? existing.completed
      }

      await db
        .update(watchStates)
        .set({
          position_seconds,
          duration_seconds: duration_seconds ?? existing.duration_seconds,
          completed: resolvedCompleted,
          updated_at: now,
        })
        .where(eq(watchStates.id, existing.id))
      const [updated] = await db
        .select()
        .from(watchStates)
        .where(eq(watchStates.id, existing.id))
      return ok(updated)
    } else {
      const id = crypto.randomUUID()
      await db.insert(watchStates).values({
        id,
        user_id: user.id,
        media_item_id: mediaItemId,
        position_seconds,
        duration_seconds: duration_seconds ?? null,
        completed: completed ?? false,
        updated_at: now,
      })
      const [created] = await db
        .select()
        .from(watchStates)
        .where(eq(watchStates.id, id))
      return ok(created)
    }
  })

  // GET /watchstate/continue-watching
  app.get('/continue-watching', { preHandler: requireAuth }, async (req) => {
    const user = req.user!
    const limit = 20

    // Get accessible library IDs for filtering
    const viewableIds = user.role === 'admin' ? null : await getViewableLibraryIds(user, db)
    if (viewableIds !== null && viewableIds.length === 0) return ok([])

    const conditions: ReturnType<typeof eq>[] = [
      eq(watchStates.user_id, user.id) as any,
      eq(watchStates.completed, false) as any,
    ]
    if (viewableIds !== null) {
      conditions.push(inArray(mediaItems.library_id, viewableIds) as any)
    }

    const rows = await db
      .select({
        watchState: watchStates,
        mediaItem: mediaItems,
      })
      .from(watchStates)
      .innerJoin(mediaItems, eq(watchStates.media_item_id, mediaItems.id))
      .where(and(...(conditions as any[])))
      .orderBy(sql`${watchStates.updated_at} DESC`)
      .limit(limit)

    // Enrich episodes with show/season context
    const enrichedItems = await Promise.all(
      rows.map(async ({ watchState, mediaItem }) => {
        let showId: string | null = null
        let showTitle: string | null = null
        let seasonNumber: number | null = mediaItem.season_number
        let episodeNumber: number | null = mediaItem.episode_number

        if (mediaItem.kind === 'episode' && mediaItem.parent_id) {
          const [season] = await db
            .select({ id: mediaItems.id, parent_id: mediaItems.parent_id, season_number: mediaItems.season_number })
            .from(mediaItems)
            .where(eq(mediaItems.id, mediaItem.parent_id))
          if (season?.parent_id) {
            showId = season.parent_id
            const [show] = await db
              .select({ title: mediaItems.title })
              .from(mediaItems)
              .where(eq(mediaItems.id, season.parent_id))
            showTitle = show?.title ?? null
          }
        }

        return {
          ...mediaItem,
          poster_path: undefined,
          backdrop_path: undefined,
          watch_state: watchState,
          ...(mediaItem.kind === 'episode'
            ? { showId, showTitle, seasonNumber, episodeNumber }
            : {}),
        }
      })
    )

    return ok(enrichedItems)
  })
}
