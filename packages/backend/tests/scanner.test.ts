import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { scanLibrary } from '../src/services/scanner'
import { libraries, mediaItems, mediaFiles } from '../src/db/schema'
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
})
