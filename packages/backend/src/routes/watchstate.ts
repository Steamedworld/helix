import type { FastifyInstance } from 'fastify'
import { eq, and, inArray } from 'drizzle-orm'
import { watchStates, mediaItems, libraries, nodes } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { sql } from 'drizzle-orm'
import { makeRequireAuth } from '../middleware/auth'
import { canViewLibrary, canPlayLibrary, getViewableLibraryIds } from '../lib/permissions'
import { createHash } from 'crypto'
import { classifySyncError } from '../services/federation/syncErrorClassifier'
import { enqueueProgressPush } from '../services/federation/progressOutbox'
import { deriveViewerIdentityHash } from '../services/federation/viewerIdentity'
import { resolveViewerIdentitySecret } from '../config'
import { logger } from '../lib/logger'

// ─── Classify enqueue error to a safe code ───────────────────────────────────
//
// Enqueue failure is non-fatal — we derive a safe label for the log entry.
// Never stores or returns raw error text.

function classifyEnqueueError(e: unknown): string {
  return classifySyncError(e).code
}

// ─── Safe viewer identity derivation ─────────────────────────────────────────
//
// Derive the opaque per-user viewer identity hash, downgrading to node mode
// (null) if the secret is unavailable (e.g. production without
// TRUSTED_HOME_VIEWER_IDENTITY_SECRET or MEDIA_TOKEN_SECRET). Identity
// derivation must never break a local progress write.

function safeViewerIdentityHash(localNodeId: string, userId: string): string | null {
  try {
    return deriveViewerIdentityHash(resolveViewerIdentitySecret(), localNodeId, userId)
  } catch {
    return null
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

      // ── Durable federated progress push (enqueue to outbox) ─────────────────
      // Only for remote items (library belongs to a remote node) when push is enabled.
      // Enqueue failure MUST NOT fail the local watchState write — fire-and-forget enqueue.
      if (localNodeId) {
        const [lib] = await db
          .select({ node_id: libraries.node_id })
          .from(libraries)
          .where(eq(libraries.id, item.library_id))
          .limit(1)
        if (lib && lib.node_id !== localNodeId) {
          const [sourceNode] = await db
            .select({ id: nodes.id, progress_sync_enabled: nodes.progress_sync_enabled, allow_progress_push: nodes.allow_progress_push, allow_progress_user_identity: nodes.allow_progress_user_identity })
            .from(nodes)
            .where(eq(nodes.id, lib.node_id))
            .limit(1)
          if (
            sourceNode &&
            sourceNode.progress_sync_enabled &&
            sourceNode.allow_progress_push
          ) {
            // Derive stable privacy-preserving client event ID — hash, never raw userId
            const clientEventId = createHash('sha256')
              .update(`${user.id}:${mediaItemId}`)
              .digest('hex')
              .slice(0, 16)

            // Per-user viewer identity (user_v1) — only when the viewer has opted in
            // for this peer. Opaque HMAC hash; never the raw user ID. Source enforces
            // its own side and downgrades to node_v1 if it has not opted in.
            const viewerIdentityHash = sourceNode.allow_progress_user_identity && localNodeId
              ? safeViewerIdentityHash(localNodeId, user.id)
              : null

            // Mark pending in watch_states before enqueue (synchronous DB write)
            await db.update(watchStates).set({
              progress_push_status: 'pending',
              progress_push_at: new Date().toISOString(),
              progress_push_error_code: null,
            }).where(eq(watchStates.id, savedWatchStateId))

            enqueueProgressPush(db, {
              nodeId: sourceNode.id,
              mediaId: mediaItemId,
              clientEventId,
              positionSeconds: position_seconds,
              durationSeconds: duration_seconds ?? existing.duration_seconds ?? null,
              watched: savedCompleted,
              localUpdatedAt: now,
              viewerIdentityHash,
            }).catch((enqueueErr) => {
              // Enqueue failure is non-fatal — log safe code, continue
              logger.warn(
                { code: classifyEnqueueError(enqueueErr) },
                '[progressOutbox] enqueue failed'
              )
            })
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

      // ── Durable federated progress push (enqueue to outbox) ─────────────────
      if (localNodeId) {
        const [lib] = await db
          .select({ node_id: libraries.node_id })
          .from(libraries)
          .where(eq(libraries.id, item.library_id))
          .limit(1)
        if (lib && lib.node_id !== localNodeId) {
          const [sourceNode] = await db
            .select({ id: nodes.id, progress_sync_enabled: nodes.progress_sync_enabled, allow_progress_push: nodes.allow_progress_push, allow_progress_user_identity: nodes.allow_progress_user_identity })
            .from(nodes)
            .where(eq(nodes.id, lib.node_id))
            .limit(1)
          if (
            sourceNode &&
            sourceNode.progress_sync_enabled &&
            sourceNode.allow_progress_push
          ) {
            // Derive stable privacy-preserving client event ID — hash, never raw userId
            const clientEventId = createHash('sha256')
              .update(`${user.id}:${mediaItemId}`)
              .digest('hex')
              .slice(0, 16)

            // Per-user viewer identity (user_v1) — only when the viewer has opted in
            // for this peer. Opaque HMAC hash; never the raw user ID. Source enforces
            // its own side and downgrades to node_v1 if it has not opted in.
            const viewerIdentityHash = sourceNode.allow_progress_user_identity && localNodeId
              ? safeViewerIdentityHash(localNodeId, user.id)
              : null

            // Mark pending in watch_states before enqueue
            await db.update(watchStates).set({
              progress_push_status: 'pending',
              progress_push_at: new Date().toISOString(),
              progress_push_error_code: null,
            }).where(eq(watchStates.id, savedWatchStateId))

            enqueueProgressPush(db, {
              nodeId: sourceNode.id,
              mediaId: mediaItemId,
              clientEventId,
              positionSeconds: position_seconds,
              durationSeconds: duration_seconds ?? null,
              watched: savedCompleted,
              localUpdatedAt: now,
              viewerIdentityHash,
            }).catch((enqueueErr) => {
              // Enqueue failure is non-fatal — log safe code, continue
              logger.warn(
                { code: classifyEnqueueError(enqueueErr) },
                '[progressOutbox] enqueue failed'
              )
            })
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
