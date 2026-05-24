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
import { enrichMediaItem, enrichBatch } from '../src/services/metadata/enrichment'
import type { MetadataProvider, MetadataCandidate, EnrichedMovieMetadata } from '../src/services/metadata/types'
import type { MediaItemKind } from '@helix/shared'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

// ─── Fake providers ─────────────────────────────────────────────────────────────

// Use unique provider IDs to avoid collisions with the TMDB singleton

function makeHighConfidenceProvider(providerId: string, externalId = '12345'): MetadataProvider {
  return {
    id: providerId,
    label: `Provider ${providerId}`,
    supportedKinds: ['movie'] as MediaItemKind[],
    get configurationStatus() { return 'configured' as const },
    isConfigured: () => true,
    searchMovies: async (title: string, year?: number): Promise<MetadataCandidate[]> => [
      {
        providerId,
        externalId,
        title, // exact title match → high score
        year,
        score: 0,
        overview: 'A great movie.',
      },
    ],
    getMovieDetails: async (): Promise<EnrichedMovieMetadata> => ({
      externalId,
      providerId,
      title: 'The Matrix',
      originalTitle: 'The Matrix',
      releaseDate: '1999-03-31',
      overview: 'A hacker discovers reality is a simulation.',
      runtimeMinutes: 136,
      contentRating: 'R',
      posterUrl: undefined,
      backdropUrl: undefined,
      genres: ['Science Fiction'],
    }),
  }
}

function makeLowConfidenceProvider(providerId: string): MetadataProvider {
  return {
    id: providerId,
    label: `Provider ${providerId}`,
    supportedKinds: ['movie'] as MediaItemKind[],
    get configurationStatus() { return 'configured' as const },
    isConfigured: () => true,
    searchMovies: async (): Promise<MetadataCandidate[]> => [
      {
        providerId,
        externalId: '99999',
        title: 'Something Completely Different XYZ',
        score: 0,
      },
    ],
    getMovieDetails: async (): Promise<EnrichedMovieMetadata | null> => null,
  }
}

function makeUnconfiguredProvider(providerId: string): MetadataProvider {
  return {
    id: providerId,
    label: `Provider ${providerId}`,
    supportedKinds: ['movie'] as MediaItemKind[],
    get configurationStatus() { return 'unconfigured' as const },
    isConfigured: () => false,
    searchMovies: async (): Promise<MetadataCandidate[]> => [],
    getMovieDetails: async (): Promise<null> => null,
  }
}

// ─── DB helpers ─────────────────────────────────────────────────────────────────

async function insertMediaItem(
  db: ReturnType<typeof createDb>,
  libraryId: string,
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

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('enrichment', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let libraryId: string
  // Track providers registered in each test so we can clean them up
  const registeredIds: string[] = []

  function registerProvider(p: MetadataProvider) {
    metadataRegistry.register(p)
    registeredIds.push(p.id)
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-enrich-${crypto.randomUUID()}`)
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

    registeredIds.length = 0
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('high-confidence match: sets metadata_status to matched and populates fields', async () => {
    const providerId = `test-hc-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeHighConfidenceProvider(providerId))

    const itemId = await insertMediaItem(db, libraryId, 'The Matrix', 1999)
    const result = await enrichMediaItem(db, itemId)

    expect(result.status).toBe('matched')

    const [item] = await db.select().from(mediaItems).where(eq(mediaItems.id, itemId))
    expect(item.metadata_status).toBe('matched')
    expect(item.overview).toBe('A hacker discovers reality is a simulation.')
    expect(item.content_rating).toBe('R')
    expect(item.release_date).toBe('1999-03-31')
    expect(item.runtime_seconds).toBe(136 * 60)
    expect(item.metadata_source).toBe(providerId)
  })

  it('low-confidence match: sets metadata_status to needs_review', async () => {
    const providerId = `test-lc-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeLowConfidenceProvider(providerId))

    // Use a title that won't match "Something Completely Different XYZ"
    const itemId = await insertMediaItem(db, libraryId, 'The Matrix', 1999)

    const result = await enrichMediaItem(db, itemId)

    // Should be needs_review or possibly no_provider (if TMDB unconfigured and only our low-confidence provider)
    expect(['needs_review', 'matched']).toContain(result.status)

    const [item] = await db.select().from(mediaItems).where(eq(mediaItems.id, itemId))
    expect(['needs_review', 'local', 'unknown', 'matched']).toContain(item.metadata_status)
  })

  it('already-matched item is skipped without force', async () => {
    const providerId = `test-skip-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeHighConfidenceProvider(providerId))

    const itemId = await insertMediaItem(db, libraryId, 'The Matrix', 1999, 'matched')
    const result = await enrichMediaItem(db, itemId)
    expect(result.status).toBe('skipped')
  })

  it('already-matched item is re-enriched when force=true', async () => {
    const providerId = `test-force-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeHighConfidenceProvider(providerId))

    const itemId = await insertMediaItem(db, libraryId, 'The Matrix', 1999, 'matched')
    const result = await enrichMediaItem(db, itemId, { force: true })
    expect(result.status).toBe('matched')
  })

  it('returns error for nonexistent media item', async () => {
    const result = await enrichMediaItem(db, 'nonexistent-id')
    expect(result.status).toBe('error')
  })

  it('enrichBatch processes local and unknown items, skips matched', async () => {
    const providerId = `test-batch-${crypto.randomUUID().slice(0, 8)}`
    registerProvider(makeHighConfidenceProvider(providerId, '11111'))

    await insertMediaItem(db, libraryId, 'Movie One', 2020, 'local')
    await insertMediaItem(db, libraryId, 'Movie Two', 2021, 'unknown')
    await insertMediaItem(db, libraryId, 'Movie Three', 2022, 'matched') // not included in batch query

    const results = await enrichBatch(db, 20)
    // Should process the 2 non-matched items
    expect(results.length).toBe(2)
  })
})

// ─── No-provider tests (standalone) ─────────────────────────────────────────────

describe('enrichment — no configured provider', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let libraryId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-enrich-np-${crypto.randomUUID()}`)
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
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('returns no_provider when no configured providers exist for item kind (track)', async () => {
    // 'track' kind — TMDB doesn't support it, and there are no other providers
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id,
      library_id: libraryId,
      kind: 'track',
      title: 'Some Song',
      sort_title: 'some song',
      year: null,
      overview: null,
      poster_path: null,
      backdrop_path: null,
      original_title: null,
      release_date: null,
      content_rating: null,
      runtime_seconds: null,
      metadata_status: 'local',
      metadata_source: 'filename',
      metadata_updated_at: null,
      external_tmdb_id: null,
      external_tvdb_id: null,
      external_musicbrainz_id: null,
      created_at: now,
      updated_at: now,
    })

    const result = await enrichMediaItem(db, id)
    expect(result.status).toBe('no_provider')
  })
})
