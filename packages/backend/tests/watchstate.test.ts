import { describe, it, expect, beforeEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { libraries, mediaItems, users, watchStates } from '../src/db/schema'
import { eq, and } from 'drizzle-orm'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

describe('watch states', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let userId: string
  let mediaItemId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-test-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    // Get the admin user created by bootstrap
    const [user] = await db.select().from(users).limit(1)
    userId = user.id

    // Create a library and media item
    const now = new Date().toISOString()
    const libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Movies',
      kind: 'movies',
      root_path: '/media/movies',
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    mediaItemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: mediaItemId,
      library_id: libraryId,
      kind: 'movie',
      title: 'Test Movie',
      sort_title: 'test movie',
      year: 2020,
      external_tmdb_id: null,
      external_tvdb_id: null,
      external_musicbrainz_id: null,
      created_at: now,
      updated_at: now,
    })
  })

  it('upserts a watch state', async () => {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(watchStates).values({
      id,
      user_id: userId,
      media_item_id: mediaItemId,
      position_seconds: 120,
      duration_seconds: 7200,
      completed: false,
      updated_at: now,
    })

    const [ws] = await db
      .select()
      .from(watchStates)
      .where(
        and(
          eq(watchStates.user_id, userId),
          eq(watchStates.media_item_id, mediaItemId)
        )
      )

    expect(ws.position_seconds).toBe(120)
    expect(ws.completed).toBe(false)
  })

  it('updates position', async () => {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(watchStates).values({
      id,
      user_id: userId,
      media_item_id: mediaItemId,
      position_seconds: 120,
      duration_seconds: 7200,
      completed: false,
      updated_at: now,
    })

    await db
      .update(watchStates)
      .set({ position_seconds: 3600, updated_at: new Date().toISOString() })
      .where(eq(watchStates.id, id))

    const [updated] = await db.select().from(watchStates).where(eq(watchStates.id, id))
    expect(updated.position_seconds).toBe(3600)
  })

  it('marks as completed', async () => {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(watchStates).values({
      id,
      user_id: userId,
      media_item_id: mediaItemId,
      position_seconds: 7100,
      duration_seconds: 7200,
      completed: false,
      updated_at: now,
    })

    await db
      .update(watchStates)
      .set({ completed: true, updated_at: new Date().toISOString() })
      .where(eq(watchStates.id, id))

    const [updated] = await db.select().from(watchStates).where(eq(watchStates.id, id))
    expect(updated.completed).toBe(true)
  })
})
