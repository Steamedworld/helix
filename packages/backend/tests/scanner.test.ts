import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { scanLibrary } from '../src/services/scanner'
import { libraries, mediaItems, mediaFiles } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

async function insertLibrary(
  db: ReturnType<typeof createDb>,
  nodeId: string,
  rootPath: string
) {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await db.insert(libraries).values({
    id,
    node_id: nodeId,
    name: 'Test Movies',
    kind: 'movies',
    root_path: rootPath,
    scan_status: 'idle',
    created_at: now,
    updated_at: now,
  })
  return {
    id,
    node_id: nodeId,
    name: 'Test Movies',
    kind: 'movies' as const,
    root_path: rootPath,
    scan_status: 'idle' as const,
    created_at: now,
    updated_at: now,
  }
}

describe('scanner', () => {
  let testDir: string
  let mediaDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-test-${crypto.randomUUID()}`)
    mediaDir = join(testDir, 'media')
    mkdirSync(mediaDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('scans and creates media items and files for mkv and mp4', async () => {
    writeFileSync(join(mediaDir, 'The Matrix (1999).mkv'), '')
    writeFileSync(join(mediaDir, 'Inception.2010.mp4'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    const counts = await scanLibrary(library, localNodeId, db)

    expect(counts.added).toBe(2)
    expect(counts.skipped).toBe(0)

    const items = await db.select().from(mediaItems)
    expect(items.length).toBe(2)

    const files = await db.select().from(mediaFiles)
    expect(files.length).toBe(2)

    const titles = items.map((i) => i.title).sort()
    expect(titles).toContain('The Matrix')
    expect(titles).toContain('Inception')

    const years = items.map((i) => i.year)
    expect(years).toContain(1999)
    expect(years).toContain(2010)
  })

  it('does not create duplicates on second scan', async () => {
    writeFileSync(join(mediaDir, 'The Matrix (1999).mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)

    const first = await scanLibrary(library, localNodeId, db)
    expect(first.added).toBe(1)

    const second = await scanLibrary(library, localNodeId, db)
    expect(second.added).toBe(0)
    expect(second.skipped).toBe(1)

    const items = await db.select().from(mediaItems)
    expect(items.length).toBe(1)
    const files = await db.select().from(mediaFiles)
    expect(files.length).toBe(1)
  })

  it('handles nested directories', async () => {
    const subDir = join(mediaDir, 'subdir')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, 'Dune (2021).mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    const counts = await scanLibrary(library, localNodeId, db)

    expect(counts.added).toBe(1)
    const items = await db.select().from(mediaItems)
    expect(items[0].title).toBe('Dune')
    expect(items[0].year).toBe(2021)
  })

  it('scanner does not overwrite enriched metadata fields on rescan', async () => {
    // Create a file and scan it
    writeFileSync(join(mediaDir, 'The Matrix (1999).mkv'), '')
    const library = await insertLibrary(db, localNodeId, mediaDir)
    await scanLibrary(library, localNodeId, db)

    // Simulate enrichment — manually update the item's metadata fields
    let items = await db.select().from(mediaItems)
    expect(items.length).toBe(1)
    const itemId = items[0].id
    const enrichedOverview = 'A hacker discovers reality is a simulation.'
    await db.update(mediaItems).set({
      metadata_status: 'matched',
      metadata_source: 'tmdb',
      overview: enrichedOverview,
      poster_path: join(mediaDir, 'downloaded-poster.jpg'),
      backdrop_path: null,
      content_rating: 'R',
      release_date: '1999-03-31',
      updated_at: new Date().toISOString(),
    }).where(eq(mediaItems.id, itemId))

    // Run a second scan — the file is already known so skipped,
    // but also add a new file to trigger the update path for existing items
    writeFileSync(join(mediaDir, 'Inception (2010).mkv'), '')
    const second = await scanLibrary(library, localNodeId, db)
    expect(second.added).toBe(1) // only Inception added

    // The Matrix item should still have enriched metadata intact
    const [matrixItem] = await db.select().from(mediaItems).where(eq(mediaItems.id, itemId))
    expect(matrixItem.metadata_status).toBe('matched')
    expect(matrixItem.overview).toBe(enrichedOverview)
    expect(matrixItem.content_rating).toBe('R')
    expect(matrixItem.release_date).toBe('1999-03-31')
  })

  it('scanner does not overwrite existing poster_path on rescan when matched', async () => {
    writeFileSync(join(mediaDir, 'The Matrix (1999).mkv'), '')
    const library = await insertLibrary(db, localNodeId, mediaDir)
    await scanLibrary(library, localNodeId, db)

    let items = await db.select().from(mediaItems)
    const itemId = items[0].id
    const cachedPosterPath = '/some/cached/poster.jpg'

    await db.update(mediaItems).set({
      metadata_status: 'matched',
      poster_path: cachedPosterPath,
      updated_at: new Date().toISOString(),
    }).where(eq(mediaItems.id, itemId))

    // Write a local poster.jpg — should NOT overwrite cached
    writeFileSync(join(mediaDir, 'poster.jpg'), 'local-poster-data')
    // Add another file to trigger a rescan with artwork detection
    writeFileSync(join(mediaDir, 'Inception (2010).mkv'), '')
    await scanLibrary(library, localNodeId, db)

    const [matrixItem] = await db.select().from(mediaItems).where(eq(mediaItems.id, itemId))
    // poster_path should remain the cached version since already set
    expect(matrixItem.poster_path).toBe(cachedPosterPath)
  })
})
