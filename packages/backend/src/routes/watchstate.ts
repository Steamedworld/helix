import type { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { watchStates, mediaItems } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'

export async function watchStateRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB }
) {
  const { db } = opts

  // PUT /watchstate/:media_item_id
  app.put<{
    Params: { media_item_id: string }
    Body: {
      user_id: string
      position_seconds: number
      duration_seconds?: number
      completed?: boolean
    }
  }>('/:media_item_id', async (req, reply) => {
    const { user_id, position_seconds, duration_seconds, completed } = req.body
    if (!user_id || position_seconds === undefined) {
      reply.status(400)
      return err('user_id and position_seconds are required')
    }

    const now = new Date().toISOString()
    const mediaItemId = req.params.media_item_id

    // Check if a watch state already exists
    const [existing] = await db
      .select()
      .from(watchStates)
      .where(
        and(
          eq(watchStates.user_id, user_id),
          eq(watchStates.media_item_id, mediaItemId)
        )
      )
      .limit(1)

    if (existing) {
      // Completion protection: never un-complete a previously completed item
      // unless the caller explicitly requests completed=false AND the position
      // is before the halfway mark (i.e. a deliberate rewatch from the start).
      // This prevents a brief position=0 update at rewatch from clearing the
      // completed flag that was earned by watching to 90%.
      let resolvedCompleted: boolean
      if (existing.completed) {
        const dur = duration_seconds ?? existing.duration_seconds ?? 0
        const halfwayPoint = dur > 0 ? dur * 0.5 : Infinity
        // Only un-complete if explicitly set to false AND position is before halfway
        if (completed === false && position_seconds < halfwayPoint) {
          resolvedCompleted = false
        } else {
          // Keep completed=true; the item stays watched even on rewatch
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
        user_id,
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
  // Only returns non-completed items (completed=false). Because completed episodes
  // stay completed (see completion-protection logic in PUT above), a finished episode
  // will never appear here — it is naturally replaced by a "Start Next Episode" CTA
  // on the ShowDetail page via GET /api/v1/shows/:id/up-next.
  app.get<{
    Querystring: { user_id: string; limit?: string }
  }>('/continue-watching', async (req, reply) => {
    const { user_id, limit = '20' } = req.query
    if (!user_id) {
      reply.status(400)
      return err('user_id is required')
    }

    const rows = await db
      .select({
        watchState: watchStates,
        mediaItem: mediaItems,
      })
      .from(watchStates)
      .innerJoin(mediaItems, eq(watchStates.media_item_id, mediaItems.id))
      .where(
        and(
          eq(watchStates.user_id, user_id),
          eq(watchStates.completed, false)
        )
      )
      .orderBy(sql`${watchStates.updated_at} DESC`)
      .limit(parseInt(limit, 10))

    // Enrich episodes with show/season context
    const enrichedItems = await Promise.all(
      rows.map(async ({ watchState, mediaItem }) => {
        let showId: string | null = null
        let showTitle: string | null = null
        let seasonNumber: number | null = mediaItem.season_number
        let episodeNumber: number | null = mediaItem.episode_number

        if (mediaItem.kind === 'episode' && mediaItem.parent_id) {
          // parent is season
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
