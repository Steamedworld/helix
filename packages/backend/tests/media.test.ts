import { describe, it, expect, beforeEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { libraries, mediaItems } from '../src/db/schema'
import { eq, like } from 'drizzle-orm'
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

describe('media items', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let libraryId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-test-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
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
  })

  async function insertItem(title: string, year: number) {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id,
      library_id: libraryId,
      kind: 'movie',
      title,
      sort_title: title.toLowerCase(),
      year,
      overview: null,
      poster_path: null,
      backdrop_path: null,
      original_title: null,
      release_date: null,
      content_rating: null,
      runtime_seconds: null,
      metadata_status: 'local',
      metadata_source: 'filename',
      metadata_updated_at: null,
      external_tmdb_id: null,
      external_tvdb_id: null,
      external_musicbrainz_id: null,
      created_at: now,
      updated_at: now,
    })
    return id
  }

  it('lists all media items', async () => {
    await insertItem('The Matrix', 1999)
    await insertItem('Inception', 2010)

    const rows = await db.select().from(mediaItems)
    expect(rows.length).toBe(2)
  })

  it('searches by title with LIKE', async () => {
    await insertItem('The Matrix', 1999)
    await insertItem('Matrix Reloaded', 2003)
    await insertItem('Inception', 2010)

    const rows = await db
      .select()
      .from(mediaItems)
      .where(like(mediaItems.title, '%Matrix%'))

    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.title.includes('Matrix'))).toBe(true)
  })

  it('fetches a single item by id', async () => {
    const id = await insertItem('Dune', 2021)

    const [item] = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.id, id))

    expect(item.title).toBe('Dune')
    expect(item.year).toBe(2021)
    expect(item.kind).toBe('movie')
  })
})
