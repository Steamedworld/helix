import { describe, it, expect, beforeEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { libraries } from '../src/db/schema'
import { eq } from 'drizzle-orm'
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

describe('library CRUD', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-test-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
  })

  it('creates and lists a library', async () => {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(libraries).values({
      id,
      node_id: localNodeId,
      name: 'My Movies',
      kind: 'movies',
      root_path: '/media/movies',
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    const rows = await db.select().from(libraries)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('My Movies')
    expect(rows[0].kind).toBe('movies')
  })

  it('updates a library', async () => {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(libraries).values({
      id,
      node_id: localNodeId,
      name: 'Old Name',
      kind: 'movies',
      root_path: '/media/old',
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    await db
      .update(libraries)
      .set({ name: 'New Name', updated_at: new Date().toISOString() })
      .where(eq(libraries.id, id))

    const [updated] = await db.select().from(libraries).where(eq(libraries.id, id))
    expect(updated.name).toBe('New Name')
  })

  it('deletes a library', async () => {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(libraries).values({
      id,
      node_id: localNodeId,
      name: 'To Delete',
      kind: 'tv',
      root_path: '/media/tv',
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    await db.delete(libraries).where(eq(libraries.id, id))

    const rows = await db.select().from(libraries).where(eq(libraries.id, id))
    expect(rows).toHaveLength(0)
  })
})
