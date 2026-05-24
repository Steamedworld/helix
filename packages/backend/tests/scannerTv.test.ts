import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { scanLibrary } from '../src/services/scanner'
import { libraries, mediaItems, mediaFiles, mediaVersions } from '../src/db/schema'
import { eq, and } from 'drizzle-orm'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs'
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
    name: 'Test TV',
    kind: 'tv',
    root_path: rootPath,
    scan_status: 'idle',
    created_at: now,
    updated_at: now,
  })
  return {
    id,
    node_id: nodeId,
    name: 'Test TV',
    kind: 'tv' as const,
    root_path: rootPath,
    scan_status: 'idle' as const,
    created_at: now,
    updated_at: now,
  }
}

describe('scanner TV hierarchy', () => {
  let testDir: string
  let mediaDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-tv-test-${crypto.randomUUID()}`)
    mediaDir = join(testDir, 'media')
    mkdirSync(mediaDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('TV filename creates show, season, episode hierarchy', async () => {
    writeFileSync(join(mediaDir, 'Breaking.Bad.S01E02.Cats.In.The.Bag.1080p.mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    const counts = await scanLibrary(library, localNodeId, db)

    expect(counts.added).toBe(1)

    const allItems = await db.select().from(mediaItems)
    // Should have: show, season, episode = 3 items
    expect(allItems.length).toBe(3)

    const show = allItems.find((i) => i.kind === 'show')
    const season = allItems.find((i) => i.kind === 'season')
    const episode = allItems.find((i) => i.kind === 'episode')

    expect(show).toBeDefined()
    expect(show!.title).toBe('Breaking Bad')
    expect(show!.parent_id).toBeNull()

    expect(season).toBeDefined()
    expect(season!.season_number).toBe(1)
    expect(season!.parent_id).toBe(show!.id)
    expect(season!.title).toBe('Season 1')

    expect(episode).toBeDefined()
    expect(episode!.episode_number).toBe(2)
    expect(episode!.season_number).toBe(1)
    expect(episode!.parent_id).toBe(season!.id)
    expect(episode!.kind).toBe('episode')
  })

  it('idempotent rescan: second scan does not create duplicates', async () => {
    writeFileSync(join(mediaDir, 'Breaking.Bad.S01E02.mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    const first = await scanLibrary(library, localNodeId, db)
    expect(first.added).toBe(1)
    expect(first.skipped).toBe(0)

    const second = await scanLibrary(library, localNodeId, db)
    expect(second.added).toBe(0)
    expect(second.skipped).toBe(1)

    // Still only 3 items (show + season + episode)
    const allItems = await db.select().from(mediaItems)
    expect(allItems.length).toBe(3)

    const allFiles = await db.select().from(mediaFiles)
    expect(allFiles.length).toBe(1)
  })

  it('multiple episodes of same show share show/season parents', async () => {
    writeFileSync(join(mediaDir, 'Breaking.Bad.S01E01.mkv'), '')
    writeFileSync(join(mediaDir, 'Breaking.Bad.S01E02.mkv'), '')
    writeFileSync(join(mediaDir, 'Breaking.Bad.S01E03.mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    const counts = await scanLibrary(library, localNodeId, db)
    expect(counts.added).toBe(3)

    const allItems = await db.select().from(mediaItems)
    // 1 show + 1 season + 3 episodes = 5
    expect(allItems.length).toBe(5)

    const shows = allItems.filter((i) => i.kind === 'show')
    expect(shows.length).toBe(1)

    const seasons = allItems.filter((i) => i.kind === 'season')
    expect(seasons.length).toBe(1)

    const episodes = allItems.filter((i) => i.kind === 'episode')
    expect(episodes.length).toBe(3)
  })

  it('multiple seasons create separate season items', async () => {
    writeFileSync(join(mediaDir, 'Breaking.Bad.S01E01.mkv'), '')
    writeFileSync(join(mediaDir, 'Breaking.Bad.S02E01.mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    await scanLibrary(library, localNodeId, db)

    const seasons = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.kind, 'season'))
    expect(seasons.length).toBe(2)
    const seasonNums = seasons.map((s) => s.season_number).sort()
    expect(seasonNums).toEqual([1, 2])
  })

  it('movie file still creates kind=movie (no regression)', async () => {
    writeFileSync(join(mediaDir, 'The Matrix (1999).mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    await scanLibrary(library, localNodeId, db)

    const allItems = await db.select().from(mediaItems)
    expect(allItems.length).toBe(1)
    expect(allItems[0].kind).toBe('movie')
    expect(allItems[0].title).toBe('The Matrix')
    expect(allItems[0].year).toBe(1999)
    expect(allItems[0].parent_id).toBeNull()
  })

  it('episode media_file attaches to episode item, not show or season', async () => {
    writeFileSync(join(mediaDir, 'Breaking.Bad.S01E02.mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    await scanLibrary(library, localNodeId, db)

    const allFiles = await db.select().from(mediaFiles)
    expect(allFiles.length).toBe(1)

    const episodeItem = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.kind, 'episode'))
      .limit(1)

    expect(episodeItem.length).toBe(1)
    expect(allFiles[0].media_item_id).toBe(episodeItem[0].id)
  })

  it('stale-file marking works for episode files', async () => {
    const filePath = join(mediaDir, 'Breaking.Bad.S01E01.mkv')
    writeFileSync(filePath, '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    await scanLibrary(library, localNodeId, db)

    let files = await db.select().from(mediaFiles)
    expect(files[0].missing_at).toBeNull()

    // Delete file and rescan
    unlinkSync(filePath)
    await scanLibrary(library, localNodeId, db)

    files = await db.select().from(mediaFiles)
    expect(files[0].missing_at).not.toBeNull()
  })

  it('rescan of matched show does not overwrite enriched fields', async () => {
    writeFileSync(join(mediaDir, 'Breaking.Bad.S01E01.mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    await scanLibrary(library, localNodeId, db)

    const [show] = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.kind, 'show'))

    // Simulate enrichment
    const enrichedOverview = 'A chemistry teacher turns to crime.'
    await db.update(mediaItems).set({
      metadata_status: 'matched',
      overview: enrichedOverview,
      poster_path: '/some/path/poster.jpg',
      updated_at: new Date().toISOString(),
    }).where(eq(mediaItems.id, show.id))

    // Add another file to trigger a rescan pass
    writeFileSync(join(mediaDir, 'Breaking.Bad.S01E02.mkv'), '')
    await scanLibrary(library, localNodeId, db)

    const [updatedShow] = await db.select().from(mediaItems).where(eq(mediaItems.id, show.id))
    expect(updatedShow.metadata_status).toBe('matched')
    expect(updatedShow.overview).toBe(enrichedOverview)
    expect(updatedShow.poster_path).toBe('/some/path/poster.jpg')
  })

  it('episode title is parsed from filename', async () => {
    writeFileSync(join(mediaDir, 'Breaking.Bad.S01E02.Cats.In.The.Bag.mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    await scanLibrary(library, localNodeId, db)

    const [episode] = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.kind, 'episode'))

    expect(episode.episode_title).toBeTruthy()
    // "Cats In The Bag" from stop-word trimming of "Cats In The Bag"
    expect(episode.episode_title).toBe("Cats In The Bag")
  })

  it('mixed TV and movie files in same library scan correctly', async () => {
    writeFileSync(join(mediaDir, 'The Matrix (1999).mkv'), '')
    writeFileSync(join(mediaDir, 'Breaking.Bad.S01E01.mkv'), '')
    writeFileSync(join(mediaDir, 'Inception.2010.mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    const counts = await scanLibrary(library, localNodeId, db)
    expect(counts.added).toBe(3)

    const allItems = await db.select().from(mediaItems)
    const movies = allItems.filter((i) => i.kind === 'movie')
    const shows = allItems.filter((i) => i.kind === 'show')
    const episodes = allItems.filter((i) => i.kind === 'episode')

    expect(movies.length).toBe(2)
    expect(shows.length).toBe(1)
    expect(episodes.length).toBe(1)
  })

  it('show-level artwork from parent directory is set on show item', async () => {
    // Create a show folder structure:
    // mediaDir/Breaking Bad/Season 1/episode.mkv
    const showDir = join(mediaDir, 'Breaking Bad')
    const seasonDir = join(showDir, 'Season 1')
    mkdirSync(seasonDir, { recursive: true })
    writeFileSync(join(showDir, 'poster.jpg'), 'fake-poster')
    writeFileSync(join(seasonDir, 'Breaking.Bad.S01E01.mkv'), '')

    const library = await insertLibrary(db, localNodeId, mediaDir)
    await scanLibrary(library, localNodeId, db)

    const [show] = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.kind, 'show'))

    // Show should have poster_path from the show directory
    expect(show.poster_path).toBeTruthy()
    expect(show.poster_path).toContain('poster.jpg')
  })
})
