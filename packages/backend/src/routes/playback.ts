import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { playbackSessions, users, mediaItems, mediaVersions, mediaFiles } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import type { PlaybackState } from '@helix/shared'

export async function playbackRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId: string }
) {
  const { db, localNodeId } = opts

  // POST /playback-sessions — create session when playback starts
  app.post<{
    Body: {
      media_item_id: string
      media_version_id: string
      media_file_id: string
      user_id?: string
    }
  }>('/', async (req, reply) => {
    const { media_item_id, media_version_id, media_file_id, user_id } = req.body

    if (!media_item_id || !media_version_id || !media_file_id) {
      reply.status(400)
      return err('media_item_id, media_version_id, and media_file_id are required')
    }

    // Resolve user: use provided user_id or fall back to first user in DB (default admin)
    let resolvedUserId = user_id
    if (!resolvedUserId) {
      const [defaultUser] = await db.select({ id: users.id }).from(users).limit(1)
      if (!defaultUser) {
        reply.status(500)
        return err('No user found — bootstrap may not have run')
      }
      resolvedUserId = defaultUser.id
    }

    // Verify referenced entities exist
    const [mediaItem] = await db.select({ id: mediaItems.id }).from(mediaItems).where(eq(mediaItems.id, media_item_id))
    if (!mediaItem) {
      reply.status(404)
      return err('Media item not found')
    }

    const [mediaVersion] = await db.select({ id: mediaVersions.id }).from(mediaVersions).where(eq(mediaVersions.id, media_version_id))
    if (!mediaVersion) {
      reply.status(404)
      return err('Media version not found')
    }

    const [mediaFile] = await db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.id, media_file_id))
    if (!mediaFile) {
      reply.status(404)
      return err('Media file not found')
    }

    const now = new Date().toISOString()
    const id = crypto.randomUUID()

    await db.insert(playbackSessions).values({
      id,
      user_id: resolvedUserId,
      node_id: localNodeId,
      media_item_id,
      media_version_id,
      media_file_id,
      state: 'starting',
      started_at: now,
      updated_at: now,
    })

    const [created] = await db.select().from(playbackSessions).where(eq(playbackSessions.id, id))
    reply.status(201)
    return ok(created)
  })

  // PATCH /playback-sessions/:id — update state and/or position
  app.patch<{
    Params: { id: string }
    Body: {
      state?: PlaybackState
      position_seconds?: number
    }
  }>('/:id', async (req, reply) => {
    const { state, position_seconds } = req.body

    if (!state && position_seconds === undefined) {
      reply.status(400)
      return err('At least one of state or position_seconds is required')
    }

    const validStates: PlaybackState[] = ['starting', 'playing', 'paused', 'stopped', 'error']
    if (state && !validStates.includes(state)) {
      reply.status(400)
      return err(`Invalid state: ${state}. Must be one of: ${validStates.join(', ')}`)
    }

    const [existing] = await db
      .select()
      .from(playbackSessions)
      .where(eq(playbackSessions.id, req.params.id))

    if (!existing) {
      reply.status(404)
      return err('Playback session not found')
    }

    const now = new Date().toISOString()
    const updates: Partial<typeof playbackSessions.$inferInsert> = { updated_at: now }
    if (state) updates.state = state

    await db
      .update(playbackSessions)
      .set(updates)
      .where(eq(playbackSessions.id, req.params.id))

    const [updated] = await db
      .select()
      .from(playbackSessions)
      .where(eq(playbackSessions.id, req.params.id))

    return ok(updated)
  })
}
