import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { detectLocalArtwork } from '../src/services/scanner'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { libraries, mediaItems, mediaVersions, mediaFiles } from '../src/db/schema'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

// ─── detectLocalArtwork unit tests ────────────────────────────────────────────

describe('detectLocalArtwork', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-artwork-test-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('finds poster.jpg in same directory', async () => {
    writeFileSync(join(testDir, 'poster.jpg'), 'fake-image-data')
    const result = await detectLocalArtwork(testDir, 'Some Movie')
    expect(result.posterPath).toBe(join(testDir, 'poster.jpg'))
  })

  it('prefers poster.jpg over cover.jpg', async () => {
    writeFileSync(join(testDir, 'cover.jpg'), 'cover-data')
    writeFileSync(join(testDir, 'poster.jpg'), 'poster-data')
    const result = await detectLocalArtwork(testDir, 'Some Movie')
    expect(result.posterPath).toBe(join(testDir, 'poster.jpg'))
  })

  it('falls back to cover.jpg when poster.jpg absent', async () => {
    writeFileSync(join(testDir, 'cover.jpg'), 'cover-data')
    const result = await detectLocalArtwork(testDir, 'Some Movie')
    expect(result.posterPath).toBe(join(testDir, 'cover.jpg'))
  })

  it('finds backdrop.jpg', async () => {
    writeFileSync(join(testDir, 'backdrop.jpg'), 'backdrop-data')
    const result = await detectLocalArtwork(testDir, 'Some Movie')
    expect(result.backdropPath).toBe(join(testDir, 'backdrop.jpg'))
  })

  it('falls back to fanart.jpg for backdrop', async () => {
    writeFileSync(join(testDir, 'fanart.jpg'), 'fanart-data')
    const result = await detectLocalArtwork(testDir, 'Some Movie')
    expect(result.backdropPath).toBe(join(testDir, 'fanart.jpg'))
  })

  it('returns null paths when no artwork present', async () => {
    const result = await detectLocalArtwork(testDir, 'Some Movie')
    expect(result.posterPath).toBeNull()
    expect(result.backdropPath).toBeNull()
  })

  it('detects poster.png when only png available', async () => {
    writeFileSync(join(testDir, 'poster.png'), 'png-data')
    const result = await detectLocalArtwork(testDir, 'Some Movie')
    expect(result.posterPath).toBe(join(testDir, 'poster.png'))
  })
})

// ─── Artwork endpoint tests ────────────────────────────────────────────────────

describe('artwork endpoint', () => {
  let testDir: string
  let mediaDir: string
  let db: ReturnType<typeof createDb>
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let libraryId: string
  let mediaItemId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-artwork-ep-${crypto.randomUUID()}`)
    mediaDir = join(testDir, 'media')
    mkdirSync(mediaDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId)

    const now = new Date().toISOString()

    // Create library
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Test Movies',
      kind: 'movies',
      root_path: mediaDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    // Create media item with a poster in the mediaDir
    const posterFile = join(mediaDir, 'poster.jpg')
    writeFileSync(posterFile, 'fake-jpeg-data')

    mediaItemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: mediaItemId,
      library_id: libraryId,
      kind: 'movie',
      title: 'Test Movie',
      sort_title: 'test movie',
      year: 2020,
      overview: null,
      poster_path: posterFile,
      backdrop_path: null,
      original_title: null,
      release_date: null,
      content_rating: null,
      runtime_seconds: null,
      metadata_status: 'local',
      metadata_source: 'filename',
      metadata_updated_at: Date.now(),
      external_tmdb_id: null,
      external_tvdb_id: null,
      external_musicbrainz_id: null,
      created_at: now,
      updated_at: now,
    })
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('returns 200 and streams image when poster artwork exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/artwork/poster`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/jpeg/)
    expect(res.headers['cache-control']).toBe('public, max-age=86400')
    expect(res.body).toBe('fake-jpeg-data')
  })

  it('returns 404 when no backdrop artwork is set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/artwork/backdrop`,
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 400 for unknown kind', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/artwork/thumbnail`,
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
  })

  it('returns 404 for unknown media item', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/nonexistent-id/artwork/poster`,
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 403 for path traversal attempt', async () => {
    const now = new Date().toISOString()
    const evilItemId = crypto.randomUUID()
    // Set poster_path to something outside all library roots
    await db.insert(mediaItems).values({
      id: evilItemId,
      library_id: libraryId,
      kind: 'movie',
      title: 'Evil Movie',
      sort_title: 'evil movie',
      year: 2020,
      overview: null,
      poster_path: '/etc/passwd',
      backdrop_path: null,
      original_title: null,
      release_date: null,
      content_rating: null,
      runtime_seconds: null,
      metadata_status: 'local',
      metadata_source: 'filename',
      metadata_updated_at: Date.now(),
      external_tmdb_id: null,
      external_tvdb_id: null,
      external_musicbrainz_id: null,
      created_at: now,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${evilItemId}/artwork/poster`,
    })
    // Should be 403 (outside library roots) or 404 (doesn't exist + path check)
    expect([403, 404]).toContain(res.statusCode)
  })
})

// ─── posterUrl in API response ─────────────────────────────────────────────────

describe('media API — posterUrl field', () => {
  let testDir: string
  let mediaDir: string
  let db: ReturnType<typeof createDb>
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let libraryId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-posterurl-${crypto.randomUUID()}`)
    mediaDir = join(testDir, 'media')
    mkdirSync(mediaDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId)

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Test Movies',
      kind: 'movies',
      root_path: mediaDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  async function insertItem(posterPath: string | null) {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id,
      library_id: libraryId,
      kind: 'movie',
      title: 'A Movie',
      sort_title: 'a movie',
      year: 2020,
      overview: null,
      poster_path: posterPath,
      backdrop_path: null,
      original_title: null,
      release_date: null,
      content_rating: null,
      runtime_seconds: null,
      metadata_status: 'local',
      metadata_source: 'filename',
      metadata_updated_at: Date.now(),
      external_tmdb_id: null,
      external_tvdb_id: null,
      external_musicbrainz_id: null,
      created_at: now,
      updated_at: now,
    })
    return id
  }

  it('posterUrl is non-null when poster_path is set', async () => {
    const posterFile = join(mediaDir, 'poster.jpg')
    writeFileSync(posterFile, 'img')
    const id = await insertItem(posterFile)

    const res = await app.inject({ method: 'GET', url: `/api/v1/media/${id}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.posterUrl).toBeTruthy()
    expect(body.data.posterUrl).toContain(`/api/v1/media/${id}/artwork/poster`)
    // Raw path must not be exposed
    expect(body.data.poster_path).toBeUndefined()
  })

  it('posterUrl is null when poster_path is not set', async () => {
    const id = await insertItem(null)

    const res = await app.inject({ method: 'GET', url: `/api/v1/media/${id}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.posterUrl).toBeNull()
  })

  it('posterUrl appears in list response', async () => {
    const posterFile = join(mediaDir, 'poster.jpg')
    writeFileSync(posterFile, 'img')
    await insertItem(posterFile)

    const res = await app.inject({ method: 'GET', url: '/api/v1/media' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data[0].posterUrl).toBeTruthy()
  })
})
