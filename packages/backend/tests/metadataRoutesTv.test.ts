import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { libraries, mediaItems } from '../src/db/schema'
import { metadataRegistry } from '../src/services/metadata/registry'
import type {
  MetadataProvider,
  MetadataCandidate,
  EnrichedMovieMetadata,
  EnrichedShowMetadata,
  EnrichedSeasonMetadata,
  EnrichedEpisodeMetadata,
} from '../src/services/metadata/types'
import type { MediaItemKind } from '@helix/shared'

// ─── DB helpers ──────────────────────────────────────────────────────────────────

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

async function insertItem(
  db: TestDb,
  libraryId: string,
  overrides: Partial<{
    kind: MediaItemKind
    title: string
    year: number | null
    metadataStatus: 'unknown' | 'local' | 'matched' | 'needs_review' | 'error'
    parentId: string | null
    seasonNumber: number | null
    episodeNumber: number | null
    externalTmdbId: string | null
    metadataSource: string | null
  }>
) {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const {
    kind = 'movie',
    title = 'Test Title',
    year = null,
    metadataStatus = 'local',
    parentId = null,
    seasonNumber = null,
    episodeNumber = null,
    externalTmdbId = null,
    metadataSource = 'filename',
  } = overrides

  await db.insert(mediaItems).values({
    id,
    library_id: libraryId,
    parent_id: parentId,
    kind,
    title,
    sort_title: title.toLowerCase(),
    year,
    overview: null,
    poster_path: null,
    backdrop_path: null,
    original_title: null,
    release_date: null,
    content_rating: null,
    runtime_seconds: null,
    season_number: seasonNumber,
    episode_number: episodeNumber,
    episode_title: null,
    absolute_episode_number: null,
    metadata_status: metadataStatus,
    metadata_source: metadataSource,
    metadata_updated_at: null,
    external_tmdb_id: externalTmdbId,
    external_tvdb_id: null,
    external_musicbrainz_id: null,
    created_at: now,
    updated_at: now,
  })
  return id
}

// ─── Fake TV provider ────────────────────────────────────────────────────────────

function makeTvProvider(id = 'test-tv-provider'): MetadataProvider {
  return {
    id,
    label: 'Test TV Provider',
    supportedKinds: ['show', 'season', 'episode', 'movie'] as MediaItemKind[],
    get configurationStatus() { return 'configured' as const },
    isConfigured: () => true,
    searchMovies: async (title: string, year?: number): Promise<MetadataCandidate[]> => [
      { providerId: id, externalId: 'm-1', title, year, score: 0 },
    ],
    getMovieDetails: async (): Promise<EnrichedMovieMetadata> => ({
      externalId: 'm-1',
      providerId: id,
      title: 'The Matrix',
      releaseDate: '1999-03-31',
      overview: 'A hacker discovers reality is a simulation.',
      runtimeMinutes: 136,
      contentRating: 'R',
    }),
    searchShows: async (title: string, year?: number): Promise<MetadataCandidate[]> => [
      {
        providerId: id,
        externalId: 'tv-1396',
        title,
        year,
        score: 0,
        overview: 'A show about meth.',
        posterUrl: 'https://image.tmdb.org/t/p/w500/poster.jpg',
      },
    ],
    getShowDetails: async (): Promise<EnrichedShowMetadata> => ({
      externalId: 'tv-1396',
      providerId: id,
      title: 'Breaking Bad',
      firstAirDate: '2008-01-20',
      overview: 'A chemistry teacher makes meth.',
      contentRating: 'TV-MA',
    }),
    getSeasonDetails: async (showId, seasonNumber): Promise<EnrichedSeasonMetadata> => ({
      externalShowId: showId,
      seasonNumber,
      overview: `Season ${seasonNumber} overview`,
    }),
    getEpisodeDetails: async (showId, seasonNumber, episodeNumber): Promise<EnrichedEpisodeMetadata> => ({
      externalShowId: showId,
      seasonNumber,
      episodeNumber,
      title: 'Pilot',
      overview: 'Walter White pilot.',
      airDate: '2008-01-20',
      runtimeMinutes: 58,
    }),
  }
}

// ─── Test suite ──────────────────────────────────────────────────────────────────

describe('metadata API routes — TV dispatch', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let libraryId: string
  const registeredIds: string[] = []

  function registerProvider(p: MetadataProvider) {
    metadataRegistry.register(p)
    registeredIds.push(p.id)
  }

  beforeEach(async () => {
    registeredIds.length = 0
    testDir = join(tmpdir(), `helix-meta-tv-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    const localNodeId = await bootstrap(db, testDir)

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Test TV',
      kind: 'tv',
      root_path: '/media/tv',
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    app = buildServer(db, localNodeId)

    // Suppress real network calls (artwork cache downloads)
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
    })
  })

  afterEach(async () => {
    await app.close()
    for (const id of registeredIds) {
      metadataRegistry.deregister(id)
    }
    registeredIds.length = 0
    rmSync(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // ─── GET /api/v1/metadata/providers ─────────────────────────────────────────

  it('TMDB provider lists show/season/episode in supportedKinds', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/providers' })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    const tmdb = body.data.providers.find((p: any) => p.id === 'tmdb')
    expect(tmdb).toBeDefined()
    expect(tmdb.supportedKinds).toContain('show')
    expect(tmdb.supportedKinds).toContain('season')
    expect(tmdb.supportedKinds).toContain('episode')
  })

  // ─── GET /api/v1/media/:id/metadata/search ───────────────────────────────────

  it('search on show item returns show candidates from TV provider', async () => {
    const providerId = `search-show-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeTvProvider(providerId))

    const showId = await insertItem(db, libraryId, { kind: 'show', title: 'Breaking Bad', year: 2008 })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${showId}/metadata/search`,
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.candidates).toBeInstanceOf(Array)
    expect(body.data.candidates.length).toBeGreaterThan(0)

    const candidate = body.data.candidates[0]
    expect(candidate.externalId).toBe('tv-1396')
    expect(candidate.score).toBeGreaterThanOrEqual(0)
    expect(candidate.posterUrl).toContain('tmdb.org')
  })

  it('search on episode item returns empty candidates with message', async () => {
    const showId = await insertItem(db, libraryId, { kind: 'show', title: 'Breaking Bad' })
    const seasonId = await insertItem(db, libraryId, {
      kind: 'season',
      title: 'S1',
      parentId: showId,
      seasonNumber: 1,
    })
    const episodeId = await insertItem(db, libraryId, {
      kind: 'episode',
      title: 'S01E01',
      parentId: seasonId,
      seasonNumber: 1,
      episodeNumber: 1,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${episodeId}/metadata/search`,
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.candidates).toHaveLength(0)
    expect(body.data.message).toMatch(/parent show/i)
  })

  it('search on season item returns empty candidates with message', async () => {
    const showId = await insertItem(db, libraryId, { kind: 'show', title: 'Breaking Bad' })
    const seasonId = await insertItem(db, libraryId, {
      kind: 'season',
      title: 'S1',
      parentId: showId,
      seasonNumber: 1,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${seasonId}/metadata/search`,
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.data.candidates).toHaveLength(0)
    expect(body.data.message).toMatch(/parent show/i)
  })

  it('search returns 404 for unknown item', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/media/nonexistent/metadata/search',
    })
    expect(res.statusCode).toBe(404)
  })

  // ─── POST /api/v1/media/:id/metadata/refresh ────────────────────────────────

  it('refresh on show item dispatches to show enrichment', async () => {
    const providerId = `refresh-show-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeTvProvider(providerId))

    const showId = await insertItem(db, libraryId, { kind: 'show', title: 'Breaking Bad', year: 2008 })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/media/${showId}/metadata/refresh`,
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('matched')
    expect(body.data.mediaItemId).toBe(showId)
  })

  it('refresh on episode when parent show is matched → episode matched', async () => {
    const providerId = `refresh-ep-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeTvProvider(providerId))

    const showId = await insertItem(db, libraryId, {
      kind: 'show',
      title: 'Breaking Bad',
      metadataStatus: 'matched',
      externalTmdbId: 'tv-1396',
      metadataSource: providerId,
    })
    const seasonId = await insertItem(db, libraryId, {
      kind: 'season',
      title: 'S1',
      parentId: showId,
      seasonNumber: 1,
    })
    const episodeId = await insertItem(db, libraryId, {
      kind: 'episode',
      title: 'S01E01',
      parentId: seasonId,
      seasonNumber: 1,
      episodeNumber: 1,
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/media/${episodeId}/metadata/refresh`,
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('matched')
  })

  it('refresh on episode when parent show is unmatched → parent_unmatched', async () => {
    const providerId = `refresh-ep-unmatched-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeTvProvider(providerId))

    const showId = await insertItem(db, libraryId, {
      kind: 'show',
      title: 'Breaking Bad',
      metadataStatus: 'local', // NOT matched
    })
    const seasonId = await insertItem(db, libraryId, {
      kind: 'season',
      title: 'S1',
      parentId: showId,
      seasonNumber: 1,
    })
    const episodeId = await insertItem(db, libraryId, {
      kind: 'episode',
      title: 'S01E01',
      parentId: seasonId,
      seasonNumber: 1,
      episodeNumber: 1,
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/media/${episodeId}/metadata/refresh`,
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('parent_unmatched')
  })

  // ─── POST /api/v1/media/:id/metadata/match ──────────────────────────────────

  it('match on show item updates show fields and enriches child seasons', async () => {
    const providerId = `match-show-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeTvProvider(providerId))

    const showId = await insertItem(db, libraryId, { kind: 'show', title: 'Breaking Bad', year: 2008 })
    const seasonId = await insertItem(db, libraryId, {
      kind: 'season',
      title: 'S1',
      parentId: showId,
      seasonNumber: 1,
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/media/${showId}/metadata/match`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, externalId: 'tv-1396' }),
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.result.status).toBe('matched')
    expect(body.data.item.metadata_status).toBe('matched')
    expect(body.data.item.overview).toBe('A chemistry teacher makes meth.')
    expect(body.data.item.content_rating).toBe('TV-MA')
  })
})
