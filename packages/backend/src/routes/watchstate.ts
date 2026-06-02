import type { FastifyInstance } from 'fastify'
import { eq, and, inArray } from 'drizzle-orm'
import { watchStates, mediaItems, libraries, nodes } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { sql } from 'drizzle-orm'
import { makeRequireAuth } from '../middleware/auth'
import { canViewLibrary, canPlayLibrary, getViewableLibraryIds } from '../lib/permissions'
import { createHash } from 'crypto'
import { decryptApiKey } from '../services/integrations/encryption'
import { config } from '../config'
import { classifySyncError } from '../services/federation/syncErrorClassifier'

// ─── Best-effort federated progress push ─────────────────────────────────────
//
// Pushes local watch progress to the source Trusted Home.
// NEVER throws — caller must fire-and-forget (.catch(() => {})).
// NEVER sends local userId to the source Home.
// NEVER fails the local watchState write.
// Uses only the stored node.base_url (SSRF prevention).

async function attemptProgressPush(
  db: DrizzleDB,
  watchStateId: string,
  userId: string,
  mediaItemId: string,
  node: typeof nodes.$inferSelect,
  progress: { positionSeconds: number; durationSeconds?: number | null; completed: boolean },
  dataDir: string
): Promise<void> {
  // Decrypt the federation token (server-side only — never sent to browser)
  let rawToken: string
  try {
    if (!node.api_token_encrypted) return
    rawToken = decryptApiKey(node.api_token_encrypted, dataDir)
  } catch {
    await db.update(watchStates).set({
      progress_push_status: 'failed',
      progress_push_at: new Date().toISOString(),
      progress_push_error_code: 'auth_failed',
    }).where(eq(watchStates.id, watchStateId))
    return
  }

  // Derive a stable, privacy-preserving client event ID from userId + mediaItemId
  // This is a hash — never the raw userId
  const clientEventId = createHash('sha256')
    .update(`${userId}:${mediaItemId}`)
    .digest('hex')
    .slice(0, 16)

  const upstreamUrl = `${node.base_url}/api/v1/federation/media/${mediaItemId}/watch-progress`

  const body = JSON.stringify({
    positionSeconds: progress.positionSeconds,
    durationSeconds: progress.durationSeconds ?? undefined,
    watched: progress.completed,
    updatedAt: new Date().toISOString(),
    clientEventId,
  })

  // Include caller node ID so the source Home can attribute the progress
  // We include the local node's concept — but we don't have localNodeId here directly.
  // Since this is best-effort, we just make the request.
  let upstreamRes: Response
  try {
    const timeoutMs = config.trustedHomeProxyRequestTimeoutMs > 0
      ? Math.min(config.trustedHomeProxyRequestTimeoutMs, 15000)
      : 15000

    upstreamRes = await fetch(upstreamUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rawToken}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (fetchErr) {
    const classified = classifySyncError(fetchErr)
    await db.update(watchStates).set({
      progress_push_status: 'failed',
      progress_push_at: new Date().toISOString(),
      progress_push_error_code: classified.code,
    }).where(eq(watchStates.id, watchStateId))
    return
  }

  if (upstreamRes.ok) {
    await db.update(watchStates).set({
      progress_push_status: 'synced',
      progress_push_at: new Date().toISOString(),
      progress_push_error_code: null,
    }).where(eq(watchStates.id, watchStateId))
  } else {
    const classified = classifySyncError({ status: upstreamRes.status })
    await db.update(watchStates).set({
      progress_push_status: 'failed',
      progress_push_at: new Date().toISOString(),
      progress_push_error_code: classified.code,
    }).where(eq(watchStates.id, watchStateId))
  }
}

export async function watchStateRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId?: string; dataDir?: string }
) {
  const { db } = opts
  const localNodeId = opts.localNodeId ?? null
  const dataDir = opts.dataDir ?? './data'
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

    // For remote items (library belongs to a remote node), also require can_play.
    // Progress is stored locally; the source Home is never mutated.
    // Admins bypass this check.
    if (user.role !== 'admin') {
      const [lib] = await db
        .select({ node_id: libraries.node_id })
        .from(libraries)
        .innerJoin(nodes, eq(libraries.node_id, nodes.id))
        .where(and(eq(libraries.id, item.library_id), eq(nodes.kind, 'remote')))
        .limit(1)
      if (lib) {
        // Item is from a remote node — require can_play
        if (!await canPlayLibrary(user, item.library_id, db)) {
          reply.status(403)
          return err('Playback not permitted for this library')
        }
      }
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

    let savedWatchStateId: string
    let savedCompleted: boolean

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

      savedWatchStateId = existing.id
      savedCompleted = resolvedCompleted

      // ── Best-effort federated progress push (fire-and-forget) ────────────────
      // Only for remote items (library belongs to a remote node) when push is enabled.
      // Push failure MUST NOT fail the local watchState write — always fire-and-forget.
      if (localNodeId) {
        const [lib] = await db
          .select({ node_id: libraries.node_id })
          .from(libraries)
          .where(eq(libraries.id, item.library_id))
          .limit(1)
        if (lib && lib.node_id !== localNodeId) {
          const [sourceNode] = await db
            .select()
            .from(nodes)
            .where(eq(nodes.id, lib.node_id))
            .limit(1)
          if (
            sourceNode &&
            sourceNode.progress_sync_enabled &&
            sourceNode.allow_progress_push
          ) {
            attemptProgressPush(
              db,
              savedWatchStateId,
              user.id,
              mediaItemId,
              sourceNode,
              { positionSeconds: position_seconds, durationSeconds: duration_seconds ?? existing.duration_seconds, completed: savedCompleted },
              dataDir
            ).catch(() => {})
          }
        }
      }

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

      savedWatchStateId = id
      savedCompleted = created?.completed ?? false

      // ── Best-effort federated progress push (fire-and-forget) ────────────────
      if (localNodeId) {
        const [lib] = await db
          .select({ node_id: libraries.node_id })
          .from(libraries)
          .where(eq(libraries.id, item.library_id))
          .limit(1)
        if (lib && lib.node_id !== localNodeId) {
          const [sourceNode] = await db
            .select()
            .from(nodes)
            .where(eq(nodes.id, lib.node_id))
            .limit(1)
          if (
            sourceNode &&
            sourceNode.progress_sync_enabled &&
            sourceNode.allow_progress_push
          ) {
            attemptProgressPush(
              db,
              savedWatchStateId,
              user.id,
              mediaItemId,
              sourceNode,
              { positionSeconds: position_seconds, durationSeconds: duration_seconds ?? null, completed: savedCompleted },
              dataDir
            ).catch(() => {})
          }
        }
      }

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
