import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { libraries, mediaItems } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { metadataRegistry } from '../src/services/metadata/registry'
import { enrichMediaItem, enrichShow, enrichEpisode, enrichBatch } from '../src/services/metadata/enrichment'
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

function makeShowProvider(providerId: string, externalId = 'tv-1396'): MetadataProvider {
  return {
    id: providerId,
    label: `Show Provider ${providerId}`,
    supportedKinds: ['show', 'season', 'episode'] as MediaItemKind[],
    get configurationStatus() { return 'configured' as const },
    isConfigured: () => true,
    searchMovies: async (): Promise<MetadataCandidate[]> => [],
    getMovieDetails: async (): Promise<null> => null,
    searchShows: async (title: string, year?: number): Promise<MetadataCandidate[]> => [
      {
        providerId,
        externalId,
        title,           // exact title match → high score
        year,
        score: 0,
        overview: 'A great show.',
        posterUrl: undefined,
        backdropUrl: undefined,
      },
    ],
    getShowDetails: async (): Promise<EnrichedShowMetadata> => ({
      externalId,
      providerId,
      title: 'Breaking Bad',
      originalTitle: 'Breaking Bad',
      firstAirDate: '2008-01-20',
      overview: 'A chemistry teacher makes meth.',
      contentRating: 'TV-MA',
      genres: ['Drama', 'Crime'],
      status: 'Ended',
    }),
    getSeasonDetails: async (showId, seasonNumber): Promise<EnrichedSeasonMetadata> => ({
      externalShowId: showId,
      seasonNumber,
      title: `Season ${seasonNumber}`,
      overview: `Overview for season ${seasonNumber}`,
      airDate: '2008-01-20',
    }),
    getEpisodeDetails: async (showId, seasonNumber, episodeNumber): Promise<EnrichedEpisodeMetadata> => ({
      externalShowId: showId,
      seasonNumber,
      episodeNumber,
      title: 'Pilot',
      overview: 'Walter White is diagnosed with lung cancer.',
      airDate: '2008-01-20',
      runtimeMinutes: 58,
    }),
  }
}

function makeLowConfidenceShowProvider(providerId: string): MetadataProvider {
  return {
    id: providerId,
    label: `Low Conf Show Provider ${providerId}`,
    supportedKinds: ['show', 'season', 'episode'] as MediaItemKind[],
    get configurationStatus() { return 'configured' as const },
    isConfigured: () => true,
    searchMovies: async (): Promise<MetadataCandidate[]> => [],
    getMovieDetails: async (): Promise<null> => null,
    searchShows: async (): Promise<MetadataCandidate[]> => [
      {
        providerId,
        externalId: 'tv-99',
        title: 'Completely Different Show XYZ ABCD',
        score: 0,
      },
    ],
    getShowDetails: async (): Promise<null> => null,
    getSeasonDetails: async (): Promise<null> => null,
    getEpisodeDetails: async (): Promise<null> => null,
  }
}

function makeMovieProvider(providerId: string): MetadataProvider {
  return {
    id: providerId,
    label: `Movie Provider ${providerId}`,
    supportedKinds: ['movie'] as MediaItemKind[],
    get configurationStatus() { return 'configured' as const },
    isConfigured: () => true,
    searchMovies: async (title: string, year?: number): Promise<MetadataCandidate[]> => [
      { providerId, externalId: 'm-1', title, year, score: 0, overview: 'A movie.' },
    ],
    getMovieDetails: async (): Promise<EnrichedMovieMetadata> => ({
      externalId: 'm-1',
      providerId,
      title: 'The Matrix',
      releaseDate: '1999-03-31',
      overview: 'A hacker discovers reality is a simulation.',
      runtimeMinutes: 136,
      contentRating: 'R',
    }),
  }
}

// ─── Test setup / teardown ────────────────────────────────────────────────────────

describe('TV enrichment', () => {
  let testDir: string
  let db: TestDb
  let libraryId: string
  const registeredIds: string[] = []

  function registerProvider(p: MetadataProvider) {
    metadataRegistry.register(p)
    registeredIds.push(p.id)
  }

  function deregisterAll() {
    for (const id of registeredIds) {
      metadataRegistry.deregister(id)
    }
    registeredIds.length = 0
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-tv-enrich-${crypto.randomUUID()}`)
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

    registeredIds.length = 0

    // Stub out cacheArtwork — no real file system or network in these tests
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
    })
  })

  afterEach(() => {
    deregisterAll()
    rmSync(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // ─── enrichShow — high confidence ────────────────────────────────────────────

  it('enrichShow: high confidence → metadata_status matched, fields populated', async () => {
    const pid = `tv-hc-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeShowProvider(pid, 'tv-1396'))

    const showId = await insertItem(db, libraryId, { kind: 'show', title: 'Breaking Bad', year: 2008 })

    const result = await enrichShow(db, showId)
    expect(result.status).toBe('matched')

    const [show] = await db.select().from(mediaItems).where(eq(mediaItems.id, showId))
    expect(show.metadata_status).toBe('matched')
    expect(show.overview).toBe('A chemistry teacher makes meth.')
    expect(show.content_rating).toBe('TV-MA')
    expect(show.release_date).toBe('2008-01-20')
    expect(show.year).toBe(2008)
    expect(show.metadata_source).toBe(pid)
    expect(show.external_tmdb_id).toBeNull() // provider id is not 'tmdb' in this test
  })

  it('enrichShow: high confidence → enriches child seasons automatically', async () => {
    const pid = `tv-seasons-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeShowProvider(pid, 'tv-999'))

    const showId = await insertItem(db, libraryId, { kind: 'show', title: 'Breaking Bad', year: 2008 })
    const seasonId = await insertItem(db, libraryId, {
      kind: 'season',
      title: 'Breaking Bad Season 1',
      parentId: showId,
      seasonNumber: 1,
    })

    const result = await enrichShow(db, showId)
    expect(result.status).toBe('matched')

    const [season] = await db.select().from(mediaItems).where(eq(mediaItems.id, seasonId))
    expect(season.metadata_status).toBe('matched')
    expect(season.overview).toContain('Overview for season 1')
  })

  it('enrichShow: low confidence → metadata_status needs_review', async () => {
    const pid = `tv-lc-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeLowConfidenceShowProvider(pid))

    const showId = await insertItem(db, libraryId, { kind: 'show', title: 'Breaking Bad', year: 2008 })
    const result = await enrichShow(db, showId)

    expect(result.status).toBe('needs_review')

    const [show] = await db.select().from(mediaItems).where(eq(mediaItems.id, showId))
    expect(show.metadata_status).toBe('needs_review')
  })

  it('enrichShow: no configured provider → no_provider', async () => {
    // No show-capable provider registered — only the global TMDB (which in test env is unconfigured)
    const showId = await insertItem(db, libraryId, { kind: 'show', title: 'Breaking Bad', year: 2008 })

    // Register only a movie provider to ensure show has no provider
    const moviePid = `mv-only-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeMovieProvider(moviePid))

    const result = await enrichShow(db, showId)
    expect(result.status).toBe('no_provider')
  })

  it('enrichShow: already matched → skipped without force', async () => {
    const pid = `tv-skip-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeShowProvider(pid))

    const showId = await insertItem(db, libraryId, {
      kind: 'show',
      title: 'Breaking Bad',
      year: 2008,
      metadataStatus: 'matched',
    })

    const result = await enrichShow(db, showId)
    expect(result.status).toBe('skipped')
  })

  it('enrichShow: already matched → re-enriched with force=true', async () => {
    const pid = `tv-force-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeShowProvider(pid))

    const showId = await insertItem(db, libraryId, {
      kind: 'show',
      title: 'Breaking Bad',
      year: 2008,
      metadataStatus: 'matched',
    })

    const result = await enrichShow(db, showId, { force: true })
    expect(result.status).toBe('matched')
  })

  // ─── enrichEpisode — parent_unmatched ────────────────────────────────────────

  it('enrichEpisode: parent show not matched → parent_unmatched', async () => {
    const pid = `tv-ep-unmatched-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeShowProvider(pid))

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
      title: 'Pilot',
      parentId: seasonId,
      seasonNumber: 1,
      episodeNumber: 1,
    })

    const result = await enrichEpisode(db, episodeId)
    expect(result.status).toBe('parent_unmatched')
    expect(result.message).toMatch(/parent show/i)
  })

  // ─── enrichEpisode — parent show matched ────────────────────────────────────

  it('enrichEpisode: parent show matched → episode fields populated', async () => {
    const pid = `tv-ep-matched-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeShowProvider(pid))

    const showId = await insertItem(db, libraryId, {
      kind: 'show',
      title: 'Breaking Bad',
      metadataStatus: 'matched',
      externalTmdbId: 'tv-1396',
      metadataSource: pid,
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

    const result = await enrichEpisode(db, episodeId)
    expect(result.status).toBe('matched')

    const [ep] = await db.select().from(mediaItems).where(eq(mediaItems.id, episodeId))
    expect(ep.metadata_status).toBe('matched')
    expect(ep.episode_title).toBe('Pilot')
    expect(ep.overview).toBe('Walter White is diagnosed with lung cancer.')
    expect(ep.release_date).toBe('2008-01-20')
    expect(ep.runtime_seconds).toBe(58 * 60)
    expect(ep.metadata_source).toBe(pid)
  })

  it('enrichEpisode: already matched → skipped without force', async () => {
    const pid = `tv-ep-skip-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeShowProvider(pid))

    const showId = await insertItem(db, libraryId, {
      kind: 'show',
      title: 'Breaking Bad',
      metadataStatus: 'matched',
      externalTmdbId: 'tv-1396',
      metadataSource: pid,
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
      metadataStatus: 'matched',
    })

    const result = await enrichEpisode(db, episodeId)
    expect(result.status).toBe('skipped')
  })

  // ─── enrichMediaItem dispatch ────────────────────────────────────────────────

  it('enrichMediaItem dispatches show → enrichShow', async () => {
    const pid = `tv-dispatch-show-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeShowProvider(pid))

    const showId = await insertItem(db, libraryId, { kind: 'show', title: 'Breaking Bad', year: 2008 })
    const result = await enrichMediaItem(db, showId)
    expect(result.status).toBe('matched')
  })

  it('enrichMediaItem dispatches episode → enrichEpisode', async () => {
    const pid = `tv-dispatch-ep-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeShowProvider(pid))

    const showId = await insertItem(db, libraryId, {
      kind: 'show',
      title: 'Breaking Bad',
      metadataStatus: 'matched',
      externalTmdbId: 'tv-1396',
      metadataSource: pid,
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

    const result = await enrichMediaItem(db, episodeId)
    expect(result.status).toBe('matched')
  })

  it('enrichMediaItem dispatches season → skipped with message', async () => {
    const seasonId = await insertItem(db, libraryId, { kind: 'season', title: 'S1' })
    const result = await enrichMediaItem(db, seasonId)
    expect(result.status).toBe('skipped')
    expect(result.message).toMatch(/parent show/i)
  })

  // ─── enrichBatch — shows before episodes ────────────────────────────────────

  it('enrichBatch processes shows before episodes', async () => {
    const pid = `tv-batch-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeShowProvider(pid))

    const showId = await insertItem(db, libraryId, {
      kind: 'show',
      title: 'Breaking Bad',
      year: 2008,
      metadataStatus: 'local',
    })
    const seasonId = await insertItem(db, libraryId, {
      kind: 'season',
      title: 'S1',
      parentId: showId,
      seasonNumber: 1,
      metadataStatus: 'local',
    })
    const episodeId = await insertItem(db, libraryId, {
      kind: 'episode',
      title: 'S01E01',
      parentId: seasonId,
      seasonNumber: 1,
      episodeNumber: 1,
      metadataStatus: 'local',
    })

    const results = await enrichBatch(db, 10)

    // Show must appear before episode in results
    const showResult = results.find((r) => r.mediaItemId === showId)
    const episodeResult = results.find((r) => r.mediaItemId === episodeId)
    const showIndex = results.indexOf(showResult!)
    const episodeIndex = results.indexOf(episodeResult!)

    expect(showIndex).toBeLessThan(episodeIndex)

    // Show should be matched; season is skipped in batch (it's a 'local' item but kind=season)
    // Episode was processed after show — show was matched so episode can be matched too
    expect(showResult!.status).toBe('matched')
  })

  // ─── Movie enrichment regression ────────────────────────────────────────────

  it('movie enrichment still works (no regression)', async () => {
    const pid = `mv-regression-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeMovieProvider(pid))

    const movieId = await insertItem(db, libraryId, {
      kind: 'movie',
      title: 'The Matrix',
      year: 1999,
    })

    const result = await enrichMediaItem(db, movieId)
    expect(result.status).toBe('matched')

    const [movie] = await db.select().from(mediaItems).where(eq(mediaItems.id, movieId))
    expect(movie.metadata_status).toBe('matched')
    expect(movie.overview).toBe('A hacker discovers reality is a simulation.')
    expect(movie.runtime_seconds).toBe(136 * 60)
  })
})
