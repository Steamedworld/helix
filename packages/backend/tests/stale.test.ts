import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { scanLibrary } from '../src/services/scanner'
import { selectBestLocalSource } from '../src/services/federation/sourceSelection'
import { libraries, mediaFiles } from '../src/db/schema'
import { eq } from 'drizzle-orm'

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

describe('stale-file detection', () => {
  let testDir: string
  let mediaDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-stale-${crypto.randomUUID()}`)
    mediaDir = join(testDir, 'media')
    mkdirSync(mediaDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('marks missing_at when file is absent on rescan', async () => {
    const filePath = join(mediaDir, 'The Matrix (1999).mkv')
    writeFileSync(filePath, '')

    const library = await insertLibrary(db, localNodeId, mediaDir)

    // First scan — file exists
    await scanLibrary(library, localNodeId, db)

    let files = await db.select().from(mediaFiles)
    expect(files.length).toBe(1)
    expect(files[0].missing_at).toBeNull()

    // Delete file
    unlinkSync(filePath)

    // Second scan — file gone
    await scanLibrary(library, localNodeId, db)

    files = await db.select().from(mediaFiles)
    expect(files.length).toBe(1)
    expect(files[0].missing_at).not.toBeNull()
    expect(typeof files[0].missing_at).toBe('number')
  })

  it('clears missing_at when file reappears on rescan', async () => {
    const filePath = join(mediaDir, 'Inception (2010).mkv')
    writeFileSync(filePath, '')

    const library = await insertLibrary(db, localNodeId, mediaDir)

    // First scan
    await scanLibrary(library, localNodeId, db)

    // Delete file
    unlinkSync(filePath)

    // Second scan — marks missing
    await scanLibrary(library, localNodeId, db)

    let files = await db.select().from(mediaFiles)
    expect(files[0].missing_at).not.toBeNull()

    // Restore file
    writeFileSync(filePath, '')

    // Third scan — clears missing_at
    await scanLibrary(library, localNodeId, db)

    files = await db.select().from(mediaFiles)
    expect(files.length).toBe(1)
    expect(files[0].missing_at).toBeNull()
  })

  it('source selection ignores files with missing_at set', async () => {
    const filePath = join(mediaDir, 'Dune (2021).mkv')
    writeFileSync(filePath, '')

    const library = await insertLibrary(db, localNodeId, mediaDir)

    // Scan to add file
    await scanLibrary(library, localNodeId, db)

    // Get the media item ID
    const files = await db.select().from(mediaFiles)
    expect(files.length).toBe(1)
    const { media_item_id } = files[0]

    // Verify source exists when file is present
    const sourcePresent = await selectBestLocalSource(media_item_id, db, localNodeId, null)
    expect(sourcePresent).not.toBeNull()

    // Delete file and mark missing
    unlinkSync(filePath)
    await scanLibrary(library, localNodeId, db)

    // Source should now be unavailable (file missing in DB)
    const sourceMissing = await selectBestLocalSource(media_item_id, db, localNodeId, null)
    expect(sourceMissing).toBeNull()
  })
})
