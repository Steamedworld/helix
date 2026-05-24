import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { scanLibrary } from '../src/services/scanner'
import { getPlaybackSource } from '../src/services/federation/sourceSelection'
import { libraries, mediaItems, mediaFiles, mediaVersions } from '../src/db/schema'
import { eq, and } from 'drizzle-orm'
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

async function insertTvLibrary(
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

describe('source selection — TV hierarchy', () => {
  let testDir: string
  let mediaDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-ss-tv-${crypto.randomUUID()}`)
    mediaDir = join(testDir, 'media')
    mkdirSync(mediaDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('getPlaybackSource for episode item returns source', async () => {
    const filePath = join(mediaDir, 'Breaking.Bad.S01E01.mkv')
    writeFileSync(filePath, 'fake video data')

    const library = await insertTvLibrary(db, localNodeId, mediaDir)
    await scanLibrary(library, localNodeId, db)

    const [episode] = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.kind, 'episode'))

    expect(episode).toBeDefined()

    const result = await getPlaybackSource(episode.id, db, localNodeId, null)
    expect(result.unavailable).toBeUndefined()
    expect(result.source).toBeDefined()
    expect(result.source!.streamUrl).toContain('/stream')
  })

  it('getPlaybackSource for show item returns unavailable with reason', async () => {
    const now = new Date().toISOString()
    const libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'TV',
      kind: 'tv',
      root_path: mediaDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    const showId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: showId,
      library_id: libraryId,
      kind: 'show',
      title: 'Breaking Bad',
      sort_title: 'breaking bad',
      year: null,
      created_at: now,
      updated_at: now,
    })

    const result = await getPlaybackSource(showId, db, localNodeId, null)
    expect(result.unavailable).toBe(true)
    expect(result.source).toBeUndefined()
    expect(typeof (result as any).reason).toBe('string')
    expect((result as any).reason).toMatch(/show/i)
  })

  it('getPlaybackSource for season item returns unavailable with reason', async () => {
    const now = new Date().toISOString()
    const libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'TV',
      kind: 'tv',
      root_path: mediaDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    const showId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: showId,
      library_id: libraryId,
      kind: 'show',
      title: 'Breaking Bad',
      sort_title: 'breaking bad',
      year: null,
      created_at: now,
      updated_at: now,
    })

    const seasonId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: seasonId,
      library_id: libraryId,
      parent_id: showId,
      kind: 'season',
      title: 'Season 1',
      sort_title: 'season 1',
      year: null,
      season_number: 1,
      created_at: now,
      updated_at: now,
    })

    const result = await getPlaybackSource(seasonId, db, localNodeId, null)
    expect(result.unavailable).toBe(true)
    expect(result.source).toBeUndefined()
    expect((result as any).reason).toMatch(/season/i)
  })
})
