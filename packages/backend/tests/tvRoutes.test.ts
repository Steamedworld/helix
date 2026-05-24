import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { libraries, mediaItems } from '../src/db/schema'
import { eq, and } from 'drizzle-orm'
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

/**
 * Creates a complete show → season → episode hierarchy in the DB.
 */
async function createTvFixture(
  db: ReturnType<typeof createDb>,
  libraryId: string,
  opts: {
    showTitle?: string
    seasonCount?: number
    episodesPerSeason?: number
  } = {}
) {
  const {
    showTitle = 'Breaking Bad',
    seasonCount = 2,
    episodesPerSeason = 3,
  } = opts
  const now = new Date().toISOString()

  const showId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: showId,
    library_id: libraryId,
    kind: 'show',
    title: showTitle,
    sort_title: showTitle.toLowerCase(),
    year: 2008,
    overview: 'A high school chemistry teacher turns to drug manufacturing.',
    poster_path: null,
    backdrop_path: null,
    content_rating: 'TV-MA',
    metadata_status: 'local',
    metadata_source: 'filename',
    created_at: now,
    updated_at: now,
  })

  const seasonIds: string[] = []
  for (let s = 1; s <= seasonCount; s++) {
    const seasonId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: seasonId,
      library_id: libraryId,
      parent_id: showId,
      kind: 'season',
      title: `Season ${s}`,
      sort_title: `season ${s}`,
      season_number: s,
      metadata_status: 'local',
      metadata_source: 'filename',
      created_at: now,
      updated_at: now,
    })
    seasonIds.push(seasonId)

    for (let e = 1; e <= episodesPerSeason; e++) {
      const epId = crypto.randomUUID()
      await db.insert(mediaItems).values({
        id: epId,
        library_id: libraryId,
        parent_id: seasonId,
        kind: 'episode',
        title: `Episode ${e}`,
        sort_title: `s${String(s).padStart(2, '0')}e${String(e).padStart(3, '0')}`,
        season_number: s,
        episode_number: e,
        episode_title: `Test Episode S${s}E${e}`,
        overview: `Overview for S${s}E${e}`,
        metadata_status: 'local',
        metadata_source: 'filename',
        created_at: now,
        updated_at: now,
      })
    }
  }

  return { showId, seasonIds }
}

describe('TV API routes', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let libraryId: string
  let app: ReturnType<typeof buildServer>
  let sessionCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-tv-routes-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'TV Shows',
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

  describe('GET /api/v1/shows', () => {
    it('returns empty list when no shows exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/shows' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data).toEqual([])
    })

    it('returns show list with episodeCount', async () => {
      await createTvFixture(db, libraryId, { seasonCount: 2, episodesPerSeason: 3 })

      const res = await app.inject({ method: 'GET', url: '/api/v1/shows' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data.length).toBe(1)
      expect(body.data[0].title).toBe('Breaking Bad')
      expect(body.data[0].episodeCount).toBe(6) // 2 seasons × 3 episodes
    })

    it('can filter by library_id', async () => {
      await createTvFixture(db, libraryId)

      // Create a second library with its own show
      const now = new Date().toISOString()
      const lib2Id = crypto.randomUUID()
      await db.insert(libraries).values({
        id: lib2Id,
        node_id: localNodeId,
        name: 'Other TV',
        kind: 'tv',
        root_path: testDir,
        scan_status: 'idle',
        created_at: now,
        updated_at: now,
      })
      await createTvFixture(db, lib2Id, { showTitle: 'The Wire' })

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/shows?library_id=${libraryId}`,
      })
      const body = JSON.parse(res.body)
      expect(body.data.length).toBe(1)
      expect(body.data[0].title).toBe('Breaking Bad')
    })
  })

  describe('GET /api/v1/shows/:id', () => {
    it('returns show detail with seasons list', async () => {
      const { showId } = await createTvFixture(db, libraryId, {
        seasonCount: 2,
        episodesPerSeason: 3,
      })

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/shows/${showId}`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data.title).toBe('Breaking Bad')
      expect(body.data.overview).toBeTruthy()
      expect(body.data.seasons).toHaveLength(2)
      expect(body.data.seasons[0].seasonNumber).toBe(1)
      expect(body.data.seasons[0].episodeCount).toBe(3)
      expect(body.data.seasons[1].seasonNumber).toBe(2)
    })

    it('returns 404 for unknown show id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/shows/nonexistent-id',
      })
      expect(res.statusCode).toBe(404)
    })

    it('returns 404 when id belongs to a non-show item', async () => {
      const now = new Date().toISOString()
      const movieId = crypto.randomUUID()
      await db.insert(mediaItems).values({
        id: movieId,
        library_id: libraryId,
        kind: 'movie',
        title: 'Some Movie',
        sort_title: 'some movie',
        metadata_status: 'local',
        metadata_source: 'filename',
        created_at: now,
        updated_at: now,
      })

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/shows/${movieId}`,
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('GET /api/v1/shows/:id/seasons', () => {
    it('returns seasons list ordered by season number', async () => {
      const { showId } = await createTvFixture(db, libraryId, { seasonCount: 3 })

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/shows/${showId}/seasons`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data).toHaveLength(3)
      const seasonNumbers = body.data.map((s: any) => s.seasonNumber)
      expect(seasonNumbers).toEqual([1, 2, 3])
    })
  })

  describe('GET /api/v1/seasons/:id/episodes', () => {
    it('returns episodes list ordered by episode number', async () => {
      const { seasonIds } = await createTvFixture(db, libraryId, {
        seasonCount: 1,
        episodesPerSeason: 5,
      })
      const seasonId = seasonIds[0]

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/seasons/${seasonId}/episodes`,
        headers: { Cookie: sessionCookie },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data).toHaveLength(5)
      const epNumbers = body.data.map((e: any) => e.episodeNumber)
      expect(epNumbers).toEqual([1, 2, 3, 4, 5])
    })

    it('returns 401 for unauthenticated request', async () => {
      const { seasonIds } = await createTvFixture(db, libraryId, {
        seasonCount: 1,
        episodesPerSeason: 1,
      })
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/seasons/${seasonIds[0]}/episodes`,
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 404 for unknown season id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/seasons/nonexistent/episodes',
        headers: { Cookie: sessionCookie },
      })
      expect(res.statusCode).toBe(404)
    })

    it('episode items include episodeTitle and overview', async () => {
      const { seasonIds } = await createTvFixture(db, libraryId, {
        seasonCount: 1,
        episodesPerSeason: 1,
      })

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/seasons/${seasonIds[0]}/episodes`,
        headers: { Cookie: sessionCookie },
      })
      const body = JSON.parse(res.body)
      const ep = body.data[0]
      expect(ep.episodeTitle).toBeTruthy()
      expect(ep.overview).toBeTruthy()
      expect(typeof ep.seasonNumber).toBe('number')
    })
  })

  describe('GET /api/v1/episodes/:id', () => {
    it('returns episode detail with showId, showTitle, seasonId', async () => {
      const { showId, seasonIds } = await createTvFixture(db, libraryId, {
        seasonCount: 1,
        episodesPerSeason: 2,
      })

      // Get the first episode
      const [ep] = await db
        .select()
        .from(mediaItems)
        .where(
          and(
            eq(mediaItems.parent_id, seasonIds[0]),
            eq(mediaItems.kind, 'episode')
          )
        )
        .limit(1)

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/episodes/${ep.id}`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data.showId).toBe(showId)
      expect(body.data.showTitle).toBe('Breaking Bad')
      expect(body.data.seasonId).toBe(seasonIds[0])
      expect(body.data.episodeNumber).toBeGreaterThan(0)
      expect(body.data.seasonNumber).toBe(1)
    })

    it('returns 404 for unknown episode id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/episodes/nonexistent',
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('season/episode ordering', () => {
    it('seasons come back in ascending season number order', async () => {
      const now = new Date().toISOString()
      const showId = crypto.randomUUID()
      await db.insert(mediaItems).values({
        id: showId,
        library_id: libraryId,
        kind: 'show',
        title: 'Test Show',
        sort_title: 'test show',
        metadata_status: 'local',
        metadata_source: 'filename',
        created_at: now,
        updated_at: now,
      })

      // Insert seasons in reverse order
      for (const sNum of [5, 3, 1, 2, 4]) {
        await db.insert(mediaItems).values({
          id: crypto.randomUUID(),
          library_id: libraryId,
          parent_id: showId,
          kind: 'season',
          title: `Season ${sNum}`,
          sort_title: `season ${sNum}`,
          season_number: sNum,
          metadata_status: 'local',
          metadata_source: 'filename',
          created_at: now,
          updated_at: now,
        })
      }

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/shows/${showId}/seasons`,
      })
      const body = JSON.parse(res.body)
      const nums = body.data.map((s: any) => s.seasonNumber)
      expect(nums).toEqual([1, 2, 3, 4, 5])
    })
  })
})
