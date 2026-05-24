import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { libraries, mediaItems, users, watchStates } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { setupAuth } from './helpers/auth'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

describe('continue-watching — episode context', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let userId: string
  let libraryId: string
  let app: ReturnType<typeof buildServer>
  let sessionCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-cw-tv-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    const [user] = await db.select().from(users).limit(1)
    userId = user.id

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'TV',
      kind: 'tv',
      root_path: testDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    app = buildServer(db, localNodeId, 'http://localhost:3001')
    await app.ready()
    sessionCookie = await setupAuth(app)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  async function createHierarchy(showTitle: string, seasonNum: number, episodeNum: number) {
    const now = new Date().toISOString()

    const showId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: showId,
      library_id: libraryId,
      kind: 'show',
      title: showTitle,
      sort_title: showTitle.toLowerCase(),
      metadata_status: 'local',
      metadata_source: 'filename',
      created_at: now,
      updated_at: now,
    })

    const seasonId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: seasonId,
      library_id: libraryId,
      parent_id: showId,
      kind: 'season',
      title: `Season ${seasonNum}`,
      sort_title: `season ${seasonNum}`,
      season_number: seasonNum,
      metadata_status: 'local',
      metadata_source: 'filename',
      created_at: now,
      updated_at: now,
    })

    const episodeId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: episodeId,
      library_id: libraryId,
      parent_id: seasonId,
      kind: 'episode',
      title: `Episode ${episodeNum}`,
      sort_title: `s${String(seasonNum).padStart(2, '0')}e${String(episodeNum).padStart(3, '0')}`,
      season_number: seasonNum,
      episode_number: episodeNum,
      episode_title: `Test Episode`,
      metadata_status: 'local',
      metadata_source: 'filename',
      created_at: now,
      updated_at: now,
    })

    return { showId, seasonId, episodeId }
  }

  it('episode in continue watching includes showTitle, seasonNumber, episodeNumber', async () => {
    const { episodeId } = await createHierarchy('Breaking Bad', 1, 2)

    // Add a watch state for the episode
    const now = new Date().toISOString()
    await db.insert(watchStates).values({
      id: crypto.randomUUID(),
      user_id: userId,
      media_item_id: episodeId,
      position_seconds: 120,
      duration_seconds: 2700,
      completed: false,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/watchstate/continue-watching`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data).toHaveLength(1)

    const item = body.data[0]
    expect(item.kind).toBe('episode')
    expect(item.showTitle).toBe('Breaking Bad')
    expect(item.seasonNumber).toBe(1)
    expect(item.episodeNumber).toBe(2)
    expect(item.showId).toBeTruthy()
  })

  it('movie in continue watching does not include showTitle', async () => {
    const now = new Date().toISOString()
    const movieId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: movieId,
      library_id: libraryId,
      kind: 'movie',
      title: 'Inception',
      sort_title: 'inception',
      year: 2010,
      metadata_status: 'local',
      metadata_source: 'filename',
      created_at: now,
      updated_at: now,
    })

    await db.insert(watchStates).values({
      id: crypto.randomUUID(),
      user_id: userId,
      media_item_id: movieId,
      position_seconds: 300,
      duration_seconds: 8820,
      completed: false,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/watchstate/continue-watching`,
      headers: { Cookie: sessionCookie },
    })

    const body = JSON.parse(res.body)
    const item = body.data[0]
    expect(item.kind).toBe('movie')
    // Movies don't get showTitle
    expect(item.showTitle).toBeUndefined()
  })

  it('completed episodes are excluded from continue watching', async () => {
    const { episodeId } = await createHierarchy('Breaking Bad', 1, 1)
    const now = new Date().toISOString()

    await db.insert(watchStates).values({
      id: crypto.randomUUID(),
      user_id: userId,
      media_item_id: episodeId,
      position_seconds: 2700,
      duration_seconds: 2700,
      completed: true,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/watchstate/continue-watching`,
      headers: { Cookie: sessionCookie },
    })

    const body = JSON.parse(res.body)
    expect(body.data).toHaveLength(0)
  })

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/watchstate/continue-watching`,
    })
    expect(res.statusCode).toBe(401)
  })
})
