import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { libraries, mediaItems } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { cacheArtwork, isPathSafeWithinCache } from '../src/services/metadata/artworkCache'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

function mockFetchImage(data = 'fake-image', contentType = 'image/jpeg') {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {
      get: (key: string) => key.toLowerCase() === 'content-type' ? contentType : null,
    },
    arrayBuffer: () => {
      const buf = Buffer.from(data, 'utf-8')
      // Return a proper ArrayBuffer (sliced from the underlying backing buffer)
      return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    },
  })
}

describe('isPathSafeWithinCache', () => {
  it('returns true for path inside cacheDir', () => {
    expect(isPathSafeWithinCache('/cache/dir/item/poster.jpg', '/cache/dir')).toBe(true)
  })

  it('returns false for path traversal attempt', () => {
    expect(isPathSafeWithinCache('/cache/dir/../../../etc/passwd', '/cache/dir')).toBe(false)
  })

  it('returns false for path outside cacheDir', () => {
    expect(isPathSafeWithinCache('/etc/passwd', '/cache/dir')).toBe(false)
  })

  it('returns true for deep nested path', () => {
    expect(isPathSafeWithinCache('/cache/dir/abc/def/poster.jpg', '/cache/dir')).toBe(true)
  })
})

describe('cacheArtwork', () => {
  let testDir: string
  let cacheDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let libraryId: string
  let originalFetch: typeof global.fetch

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-artwork-cache-${crypto.randomUUID()}`)
    cacheDir = join(testDir, 'metadata_cache')
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    originalFetch = global.fetch

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
    global.fetch = originalFetch
    rmSync(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function insertItem(posterPath: string | null = null, backdropPath: string | null = null) {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id,
      library_id: libraryId,
      kind: 'movie',
      title: 'Test Movie',
      sort_title: 'test movie',
      year: 2020,
      overview: null,
      poster_path: posterPath,
      backdrop_path: backdropPath,
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
    return id
  }

  it('downloads and saves poster to correct path', async () => {
    global.fetch = mockFetchImage('fake-poster-data', 'image/jpeg') as any
    const itemId = await insertItem()

    const result = await cacheArtwork(db, itemId, 'poster', 'https://example.com/poster.jpg', cacheDir)

    expect(result).not.toBeNull()
    expect(result).toContain('poster')
    expect(existsSync(result!)).toBe(true)
    expect(readFileSync(result!).toString()).toBe('fake-poster-data')
  })

  it('saves to {cacheDir}/{itemId}/{kind}.{ext}', async () => {
    global.fetch = mockFetchImage('data', 'image/jpeg') as any
    const itemId = await insertItem()

    const result = await cacheArtwork(db, itemId, 'poster', 'https://example.com/poster.jpg', cacheDir)

    expect(result).toContain(itemId)
    expect(result).toMatch(/poster\.jpe?g$/)
  })

  it('updates DB poster_path after successful download', async () => {
    global.fetch = mockFetchImage('img', 'image/jpeg') as any
    const itemId = await insertItem()

    await cacheArtwork(db, itemId, 'poster', 'https://example.com/p.jpg', cacheDir)

    const [item] = await db.select({ poster_path: mediaItems.poster_path }).from(mediaItems).where(eq(mediaItems.id, itemId))
    expect(item.poster_path).not.toBeNull()
  })

  it('local artwork wins — does not overwrite existing poster_path', async () => {
    const localPath = join(testDir, 'media', 'poster.jpg')
    mkdirSync(join(testDir, 'media'), { recursive: true })
    const { writeFileSync } = await import('fs')
    writeFileSync(localPath, 'local-poster-data')

    global.fetch = mockFetchImage('remote-data') as any
    const itemId = await insertItem(localPath) // has existing poster_path

    const result = await cacheArtwork(db, itemId, 'poster', 'https://example.com/p.jpg', cacheDir)

    // Should return the existing local path (no download)
    expect(result).toBe(localPath)

    // Fetch should NOT have been called
    expect(global.fetch).not.toHaveBeenCalled()

    // DB still has original path
    const [item] = await db.select({ poster_path: mediaItems.poster_path }).from(mediaItems).where(eq(mediaItems.id, itemId))
    expect(item.poster_path).toBe(localPath)
  })

  it('returns null when fetch fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
    }) as any
    const itemId = await insertItem()

    const result = await cacheArtwork(db, itemId, 'poster', 'https://example.com/missing.jpg', cacheDir)
    expect(result).toBeNull()
  })

  it('returns null for nonexistent media item', async () => {
    global.fetch = mockFetchImage() as any
    const result = await cacheArtwork(db, 'nonexistent-id', 'poster', 'https://example.com/p.jpg', cacheDir)
    expect(result).toBeNull()
  })

  it('handles PNG content-type correctly', async () => {
    global.fetch = mockFetchImage('png-data', 'image/png') as any
    const itemId = await insertItem()

    const result = await cacheArtwork(db, itemId, 'poster', 'https://example.com/poster.png', cacheDir)
    expect(result).toMatch(/\.png$/)
  })

  it('downloads backdrop separately from poster', async () => {
    global.fetch = mockFetchImage('backdrop-data', 'image/jpeg') as any
    const itemId = await insertItem()

    const result = await cacheArtwork(db, itemId, 'backdrop', 'https://example.com/backdrop.jpg', cacheDir)
    expect(result).toContain('backdrop')

    const [item] = await db.select({ backdrop_path: mediaItems.backdrop_path }).from(mediaItems).where(eq(mediaItems.id, itemId))
    expect(item.backdrop_path).not.toBeNull()
  })
})
