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
import type { MetadataProvider, MetadataCandidate, EnrichedMovieMetadata } from '../src/services/metadata/types'
import type { MediaItemKind } from '@helix/shared'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

// ─── Fake provider ───────────────────────────────────────────────────────────────

function makeConfiguredProvider(id = 'test-provider'): MetadataProvider {
  return {
    id,
    label: 'Test Provider',
    supportedKinds: ['movie'] as MediaItemKind[],
    get configurationStatus() { return 'configured' as const },
    isConfigured: () => true,
    searchMovies: async (title: string, year?: number): Promise<MetadataCandidate[]> => [
      {
        providerId: id,
        externalId: '12345',
        title,
        year,
        overview: 'A great movie.',
        score: 0,
        posterUrl: 'https://image.tmdb.org/t/p/w500/poster.jpg',
      },
    ],
    getMovieDetails: async (): Promise<EnrichedMovieMetadata> => ({
      externalId: '12345',
      providerId: id,
      title: 'The Matrix',
      releaseDate: '1999-03-31',
      overview: 'A hacker discovers reality is a simulation.',
      runtimeMinutes: 136,
      contentRating: 'R',
    }),
  }
}

describe('metadata API routes', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let libraryId: string
  let registeredTestProvider: MetadataProvider | null = null

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-meta-routes-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Test Movies',
      kind: 'movies',
      root_path: '/media/movies',
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    app = buildServer(db, localNodeId)
    registeredTestProvider = null
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
    // Clean up any test provider we registered
    if (registeredTestProvider) {
      // Re-register the real unconfigured TMDB (no-creds) to restore state
      // The actual singleton is already re-seeded by next buildServer call
    }
  })

  async function insertItem(
    title: string,
    year: number | null = null,
    metadataStatus: 'unknown' | 'local' | 'matched' | 'needs_review' | 'error' = 'local'
  ) {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id,
      library_id: libraryId,
      kind: 'movie',
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
      metadata_status: metadataStatus,
      metadata_source: 'filename',
      metadata_updated_at: null,
      external_tmdb_id: null,
      external_tvdb_id: null,
      external_musicbrainz_id: null,
      created_at: now,
      updated_at: now,
    })
    return id
  }

  // ─── GET /api/v1/metadata/providers ──────────────────────────────────────────

  it('GET /api/v1/metadata/providers returns provider list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/providers' })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.providers).toBeInstanceOf(Array)
    // TMDB is always registered (may be unconfigured if no env vars set)
    const tmdb = body.data.providers.find((p: any) => p.id === 'tmdb')
    expect(tmdb).toBeDefined()
    expect(tmdb.label).toBe('The Movie Database')
    expect(['configured', 'unconfigured']).toContain(tmdb.status)
    expect(tmdb.supportedKinds).toContain('movie')
  })

  it('GET /api/v1/metadata/providers includes custom registered provider', async () => {
    const provider = makeConfiguredProvider('custom-provider')
    metadataRegistry.register(provider)
    registeredTestProvider = provider

    const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/providers' })
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    const found = body.data.providers.find((p: any) => p.id === 'custom-provider')
    expect(found).toBeDefined()
    expect(found.status).toBe('configured')
  })

  // ─── GET /api/v1/media/:id/metadata/search ───────────────────────────────────

  it('GET /api/v1/media/:id/metadata/search returns candidates from configured provider', async () => {
    const provider = makeConfiguredProvider('search-provider')
    metadataRegistry.register(provider)
    registeredTestProvider = provider

    const itemId = await insertItem('The Matrix', 1999)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}/metadata/search`,
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.candidates).toBeInstanceOf(Array)
    expect(body.data.candidates.length).toBeGreaterThan(0)

    const candidate = body.data.candidates[0]
    expect(candidate.externalId).toBe('12345')
    expect(candidate.score).toBeGreaterThanOrEqual(0)
    // posterUrl is the remote TMDB URL
    expect(candidate.posterUrl).toContain('tmdb.org')
  })

  it('GET /api/v1/media/:id/metadata/search returns 404 for unknown item', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/media/nonexistent-id/metadata/search',
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/v1/media/:id/metadata/search returns sorted candidates by score desc', async () => {
    const provider = makeConfiguredProvider('sort-provider')
    metadataRegistry.register(provider)

    const itemId = await insertItem('The Matrix', 1999)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${itemId}/metadata/search`,
    })
    const body = JSON.parse(res.body)
    const scores: number[] = body.data.candidates.map((c: any) => c.score)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i])
    }
  })

  // ─── POST /api/v1/media/:id/metadata/match ───────────────────────────────────

  it('POST /api/v1/media/:id/metadata/match updates item', async () => {
    // Mock fetch so cacheArtwork doesn't make real network calls
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
    }) as any

    const provider = makeConfiguredProvider('match-provider')
    metadataRegistry.register(provider)

    const itemId = await insertItem('The Matrix', 1999)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/media/${itemId}/metadata/match`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'match-provider', externalId: '12345' }),
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.result.status).toBe('matched')
    expect(body.data.item.metadata_status).toBe('matched')
    expect(body.data.item.overview).toBe('A hacker discovers reality is a simulation.')
  })

  it('POST /api/v1/media/:id/metadata/match returns 404 for unknown item', async () => {
    const provider = makeConfiguredProvider('match-provider-404')
    metadataRegistry.register(provider)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/media/nonexistent/metadata/match',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'match-provider-404', externalId: '12345' }),
    })
    expect(res.statusCode).toBe(404)
  })

  it('POST /api/v1/media/:id/metadata/match returns 400 without required fields', async () => {
    const itemId = await insertItem('The Matrix')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/media/${itemId}/metadata/match`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.statusCode).toBe(400)
  })

  // ─── POST /api/v1/metadata/enrich ────────────────────────────────────────────

  it('POST /api/v1/metadata/enrich returns enrichment results', async () => {
    // Mock fetch for artwork caching
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
    }) as any

    const provider = makeConfiguredProvider('enrich-provider')
    metadataRegistry.register(provider)

    await insertItem('The Matrix', 1999, 'local')
    await insertItem('Inception', 2010, 'unknown')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/metadata/enrich',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 5 }),
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.count).toBe(2)
    expect(body.data.results).toHaveLength(2)
  })

  // ─── POST /api/v1/media/:id/metadata/refresh ─────────────────────────────────

  it('POST /api/v1/media/:id/metadata/refresh force re-enriches matched item', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
    }) as any

    const provider = makeConfiguredProvider('refresh-provider')
    metadataRegistry.register(provider)

    const itemId = await insertItem('The Matrix', 1999, 'matched')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/media/${itemId}/metadata/refresh`,
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    // The provider returns a matched result
    expect(body.data.status).toBe('matched')
  })
})
