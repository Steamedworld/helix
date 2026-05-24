import { describe, it, expect, beforeEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations, getMigrationsFolder } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { nodes, users } from '../src/db/schema'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

describe('getMigrationsFolder', () => {
  it('resolves to a path ending in /drizzle that exists on disk', () => {
    const folder = getMigrationsFolder()
    expect(folder.endsWith('drizzle')).toBe(true)
    expect(existsSync(folder)).toBe(true)
    expect(existsSync(join(folder, 'meta/_journal.json'))).toBe(true)
  })
})

describe('bootstrap', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-test-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
  })

  it('creates one local node and one admin user on first run', async () => {
    await bootstrap(db, testDir)

    const nodeRows = await db.select().from(nodes)
    const userRows = await db.select().from(users)

    expect(nodeRows).toHaveLength(1)
    expect(nodeRows[0].kind).toBe('local')
    expect(nodeRows[0].name).toBe('Helix Local')
    expect(nodeRows[0].status).toBe('online')

    expect(userRows).toHaveLength(1)
    expect(userRows[0].display_name).toBe('Admin')
    expect(userRows[0].role).toBe('admin')
  })

  it('does not create duplicates on second run', async () => {
    await bootstrap(db, testDir)
    await bootstrap(db, testDir)

    const nodeRows = await db.select().from(nodes)
    const userRows = await db.select().from(users)

    expect(nodeRows).toHaveLength(1)
    expect(userRows).toHaveLength(1)
  })

  it('returns the local node id', async () => {
    const nodeId = await bootstrap(db, testDir)
    expect(typeof nodeId).toBe('string')
    expect(nodeId.length).toBeGreaterThan(0)

    const nodeRows = await db.select().from(nodes)
    expect(nodeRows[0].id).toBe(nodeId)
  })
})
