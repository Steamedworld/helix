/**
 * Tombstone pruner tests.
 *
 * Covers:
 *   - Prunes tombstones older than retention cutoff (1 test)
 *   - Keeps tombstones newer than cutoff (1 test)
 *   - Idempotent: running pruner twice is safe (1 test)
 *   - Returns correct pruned count (1 test)
 *   - Does not touch catalog rows (media_items untouched after pruning) (1 test)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { catalogTombstones, mediaItems, libraries } from '../src/db/schema'
import { pruneTombstones } from '../src/services/federation/tombstonePruner'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

describe('Tombstone pruner', () => {
  let testDir: string
  let db: TestDb
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-pruner-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  async function insertTombstone(entityId: string, deletedAtIso: string) {
    await db.insert(catalogTombstones).values({
      id: crypto.randomUUID(),
      node_id: localNodeId,
      entity_type: 'media_file',
      entity_id: entityId,
      deleted_at: deletedAtIso,
      reason: 'scan_missing',
      created_at: deletedAtIso,
    })
  }

  // Test 1: prunes tombstones older than the retention cutoff
  it('prunes tombstones older than retention cutoff', async () => {
    // Insert a tombstone from 100 days ago (older than 90-day retention)
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    await insertTombstone('file-old', oldDate)

    const { pruned } = await pruneTombstones(db, 90)
    expect(pruned).toBe(1)

    const remaining = await db.select().from(catalogTombstones)
    expect(remaining.length).toBe(0)
  })

  // Test 2: keeps tombstones newer than the retention cutoff
  it('keeps tombstones newer than retention cutoff', async () => {
    // Insert a tombstone from 1 day ago (within 90-day retention)
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
    await insertTombstone('file-recent', recentDate)

    const { pruned } = await pruneTombstones(db, 90)
    expect(pruned).toBe(0)

    const remaining = await db.select().from(catalogTombstones)
    expect(remaining.length).toBe(1)
    expect(remaining[0].entity_id).toBe('file-recent')
  })

  // Test 3: idempotent — running pruner twice with same cutoff is safe
  it('is idempotent: running twice with same cutoff deletes nothing on second run', async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    await insertTombstone('file-old2', oldDate)

    const first = await pruneTombstones(db, 90)
    expect(first.pruned).toBe(1)

    const second = await pruneTombstones(db, 90)
    expect(second.pruned).toBe(0)
  })

  // Test 4: returns correct pruned count
  it('returns correct pruned count when multiple tombstones are pruned', async () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()
    await insertTombstone('file-a', oldDate)
    await insertTombstone('file-b', oldDate)
    await insertTombstone('file-c', oldDate)

    // Insert one recent one that should NOT be pruned
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    await insertTombstone('file-recent', recentDate)

    const { pruned } = await pruneTombstones(db, 90)
    expect(pruned).toBe(3)

    const remaining = await db.select().from(catalogTombstones)
    expect(remaining.length).toBe(1)
    expect(remaining[0].entity_id).toBe('file-recent')
  })

  // Test 5: does not touch media_items (catalog rows untouched after pruning)
  it('does not touch media_items — only catalog_tombstones are deleted', async () => {
    // Insert an old tombstone
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    await insertTombstone('some-file', oldDate)

    // Insert a library and media item in the local node's catalog
    const libId = crypto.randomUUID()
    const itemId = crypto.randomUUID()
    const now = new Date().toISOString()
    await db.insert(libraries).values({
      id: libId,
      node_id: localNodeId,
      name: 'Movies',
      kind: 'movies',
      root_path: '/movies',
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })
    await db.insert(mediaItems).values({
      id: itemId,
      library_id: libId,
      kind: 'movie',
      title: 'Should Not Be Deleted',
      sort_title: 'should not be deleted',
      metadata_status: 'matched',
      created_at: now,
      updated_at: now,
    })

    // Run pruner
    const { pruned } = await pruneTombstones(db, 90)
    expect(pruned).toBe(1)

    // media_items must still exist
    const items = await db.select().from(mediaItems).where(
      (await import('drizzle-orm')).eq(mediaItems.id, itemId)
    )
    expect(items.length).toBe(1)
    expect(items[0].title).toBe('Should Not Be Deleted')
  })
})
