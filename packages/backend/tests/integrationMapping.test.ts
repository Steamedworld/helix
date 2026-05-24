/**
 * Integration mapping tests — maps Radarr/Sonarr entries to Helix media items.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { libraries, mediaItems, integrations } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { mapRadarrMovies, mapSonarrSeries } from '../src/services/integrations/mapping'
import { syncIntegration } from '../src/services/integrations/service'
import { encryptApiKey } from '../src/services/integrations/encryption'
import type { ArrMovieSummary, ArrSeriesSummary } from '../src/services/integrations/types'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

async function insertMovieItem(db: TestDb, libraryId: string, title: string, year: number | null, tmdbId?: string) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.insert(mediaItems).values({
    id,
    library_id: libraryId,
    kind: 'movie',
    title,
    sort_title: title.toLowerCase(),
    year,
    external_tmdb_id: tmdbId ?? null,
    metadata_status: 'local',
    metadata_source: 'filename',
    created_at: now,
    updated_at: now,
  })
  return id
}

async function insertShowItem(db: TestDb, libraryId: string, title: string, year: number | null, tmdbId?: string, tvdbId?: string) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.insert(mediaItems).values({
    id,
    library_id: libraryId,
    kind: 'show',
    title,
    sort_title: title.toLowerCase(),
    year,
    external_tmdb_id: tmdbId ?? null,
    external_tvdb_id: tvdbId ?? null,
    metadata_status: 'local',
    metadata_source: 'filename',
    created_at: now,
    updated_at: now,
  })
  return id
}

describe('integration mapping', () => {
  let testDir: string
  let db: TestDb
  let localNodeId: string
  let libraryId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-mapping-test-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    // Create a test library
    libraryId = crypto.randomUUID()
    const now = new Date().toISOString()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Test Movies',
      kind: 'movies',
      root_path: '/tmp/movies',
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe('mapRadarrMovies', () => {
    it('maps movie by TMDB id', async () => {
      const movieId = await insertMovieItem(db, libraryId, 'Fight Club', 1999, '550')

      const movies: ArrMovieSummary[] = [
        { externalId: 42, tmdbId: 550, title: 'Fight Club', year: 1999, monitored: true, hasFile: true },
      ]

      const results = await mapRadarrMovies(db, movies)
      expect(results).toHaveLength(1)
      expect(results[0].helixItemId).toBe(movieId)
      expect(results[0].arrMovie?.externalId).toBe(42)
    })

    it('maps movie by title+year fallback when no TMDB id match', async () => {
      const movieId = await insertMovieItem(db, libraryId, 'Inception', 2010)

      const movies: ArrMovieSummary[] = [
        { externalId: 99, tmdbId: 99999, title: 'Inception', year: 2010, monitored: true, hasFile: true },
      ]

      const results = await mapRadarrMovies(db, movies)
      // tmdbId 99999 won't match any helix item, falls back to title+year
      expect(results).toHaveLength(1)
      expect(results[0].helixItemId).toBe(movieId)
    })

    it('returns no link when movie has no match', async () => {
      await insertMovieItem(db, libraryId, 'The Dark Knight', 2008)

      const movies: ArrMovieSummary[] = [
        { externalId: 77, tmdbId: 99990, title: 'Avatar', year: 2009, monitored: false, hasFile: false },
      ]

      const results = await mapRadarrMovies(db, movies)
      expect(results).toHaveLength(0)
    })

    it('handles case-insensitive title matching', async () => {
      const movieId = await insertMovieItem(db, libraryId, 'The Matrix', 1999)

      const movies: ArrMovieSummary[] = [
        { externalId: 5, title: 'the matrix', year: 1999, monitored: true, hasFile: true },
      ]

      const results = await mapRadarrMovies(db, movies)
      expect(results).toHaveLength(1)
      expect(results[0].helixItemId).toBe(movieId)
    })
  })

  describe('mapSonarrSeries', () => {
    it('maps series by title+year when no ids match', async () => {
      const showId = await insertShowItem(db, libraryId, 'Breaking Bad', 2008)

      const series: ArrSeriesSummary[] = [
        { externalId: 1, tvdbId: 81189, title: 'Breaking Bad', year: 2008, monitored: true, status: 'ended' },
      ]

      const results = await mapSonarrSeries(db, series)
      expect(results).toHaveLength(1)
      expect(results[0].helixItemId).toBe(showId)
    })

    it('maps series by TVDB id when Helix has external_tvdb_id', async () => {
      const showId = await insertShowItem(db, libraryId, 'Breaking Bad', 2008, undefined, '81189')

      const series: ArrSeriesSummary[] = [
        { externalId: 1, tvdbId: 81189, title: 'Breaking Bad', year: 2008, monitored: true, status: 'ended' },
      ]

      const results = await mapSonarrSeries(db, series)
      expect(results).toHaveLength(1)
      expect(results[0].helixItemId).toBe(showId)
    })
  })

  describe('syncIntegration', () => {
    it('duplicate sync does not create duplicate links (idempotent)', async () => {
      const movieId = await insertMovieItem(db, libraryId, 'Inception', 2010, '27205')

      // Create a radarr integration
      const integrationId = crypto.randomUUID()
      const now = Date.now()
      const encKey = encryptApiKey('test-key', testDir)
      await db.insert(integrations).values({
        id: integrationId,
        kind: 'radarr',
        name: 'Radarr Test',
        base_url: 'http://localhost:7878',
        api_key_encrypted: encKey,
        enabled: 1,
        status: 'unknown',
        created_at: now,
        updated_at: now,
      })

      // Mock fetch to return one movie
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      const movieResponse = [{ id: 5, tmdbId: 27205, title: 'Inception', year: 2010, monitored: true, hasFile: true, qualityProfileId: 1 }]
      const profileResponse = [{ id: 1, name: 'HD-1080p' }]

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => movieResponse })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => profileResponse })

      const result1 = await syncIntegration(db, integrationId, testDir)
      expect(result1.linksCreated).toBe(1)
      expect(result1.linksUpdated).toBe(0)

      // Sync again — should update, not create
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => movieResponse })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => profileResponse })

      const result2 = await syncIntegration(db, integrationId, testDir)
      expect(result2.linksCreated).toBe(0)
      expect(result2.linksUpdated).toBe(1)

      vi.unstubAllGlobals()
    })

    it('disabled integration returns error in sync result', async () => {
      const integrationId = crypto.randomUUID()
      const now = Date.now()
      const encKey = encryptApiKey('test-key', testDir)
      await db.insert(integrations).values({
        id: integrationId,
        kind: 'radarr',
        name: 'Disabled Radarr',
        base_url: 'http://localhost:7878',
        api_key_encrypted: encKey,
        enabled: 0,  // disabled
        status: 'unknown',
        created_at: now,
        updated_at: now,
      })

      const result = await syncIntegration(db, integrationId, testDir)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain('not found or disabled')
    })

    it('sync result counts are correct', async () => {
      await insertMovieItem(db, libraryId, 'The Matrix', 1999, '603')
      await insertMovieItem(db, libraryId, 'The Matrix Reloaded', 2003, '604')

      const integrationId = crypto.randomUUID()
      const now = Date.now()
      const encKey = encryptApiKey('test-key', testDir)
      await db.insert(integrations).values({
        id: integrationId,
        kind: 'radarr',
        name: 'Radarr',
        base_url: 'http://localhost:7878',
        api_key_encrypted: encKey,
        enabled: 1,
        status: 'unknown',
        created_at: now,
        updated_at: now,
      })

      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { id: 1, tmdbId: 603, title: 'The Matrix', year: 1999, monitored: true, hasFile: true, qualityProfileId: 1 },
          { id: 2, tmdbId: 604, title: 'The Matrix Reloaded', year: 2003, monitored: false, hasFile: false, qualityProfileId: 1 },
          { id: 3, tmdbId: 99999, title: 'Unmatched Movie', year: 2020, monitored: true, hasFile: true, qualityProfileId: 1 },
        ],
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 1, name: 'HD' }],
      })

      const result = await syncIntegration(db, integrationId, testDir)
      expect(result.itemsFetched).toBe(3)
      expect(result.itemsMapped).toBe(2)
      expect(result.linksCreated).toBe(2)
      expect(result.linksUpdated).toBe(0)
      expect(result.errors).toHaveLength(0)

      vi.unstubAllGlobals()
    })
  })
})
