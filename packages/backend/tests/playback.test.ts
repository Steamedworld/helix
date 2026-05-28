import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { libraries, mediaItems, mediaVersions, mediaFiles, users } from '../src/db/schema'
import { setupAuth } from './helpers/auth'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

/**
 * Creates a minimal media item + version + file in the DB, and optionally
 * writes a real file to disk.
 */
async function createMediaFixture(
  db: ReturnType<typeof createDb>,
  localNodeId: string,
  libraryId: string,
  filePath: string,
  opts: {
    writeFile?: boolean
    fileContent?: Buffer
    resolution_width?: number
    resolution_height?: number
  } = {}
) {
  const now = new Date().toISOString()

  if (opts.writeFile !== false) {
    const content = opts.fileContent ?? Buffer.from('fake video content for testing')
    writeFileSync(filePath, content)
  }

  const mediaItemId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: mediaItemId,
    library_id: libraryId,
    kind: 'movie',
    title: 'Test Movie',
    sort_title: 'test movie',
    year: 2023,
    external_tmdb_id: null,
    external_tvdb_id: null,
    external_musicbrainz_id: null,
    created_at: now,
    updated_at: now,
  })

  const mediaVersionId = crypto.randomUUID()
  await db.insert(mediaVersions).values({
    id: mediaVersionId,
    media_item_id: mediaItemId,
    label: null,
    quality_label: opts.resolution_width ? `${opts.resolution_height}p` : null,
    resolution_width: opts.resolution_width ?? null,
    resolution_height: opts.resolution_height ?? null,
    video_codec: null,
    audio_codec: null,
    container: 'mp4',
    duration_seconds: 7200,
    created_at: now,
    updated_at: now,
  })

  const mediaFileId = crypto.randomUUID()
  await db.insert(mediaFiles).values({
    id: mediaFileId,
    node_id: localNodeId,
    library_id: libraryId,
    media_item_id: mediaItemId,
    media_version_id: mediaVersionId,
    path: filePath,
    filename: 'test.mp4',
    extension: '.mp4',
    size_bytes: opts.fileContent?.length ?? 30,
    file_hash: null,
    discovered_at: now,
    updated_at: now,
  })

  return { mediaItemId, mediaVersionId, mediaFileId }
}

describe('streaming endpoint', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let libraryId: string
  let app: ReturnType<typeof buildServer>
  let sessionCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-stream-test-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Movies',
      kind: 'movies',
      root_path: testDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    app = buildServer(db, localNodeId, 'http://localhost:3001')
    await app.ready()
    sessionCookie = await setupAuth(app)
  })

  it('returns 404 for unknown file id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/media-files/nonexistent-id/stream',
      headers: { Cookie: sessionCookie },
    })
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/not found/i)
  })

  it('returns 200 and full file for request without Range header', async () => {
    const fileContent = Buffer.from('FAKE VIDEO DATA ABCDEFGHIJ 1234567890')
    const filePath = join(testDir, 'test-full.mp4')
    const { mediaFileId } = await createMediaFixture(db, localNodeId, libraryId, filePath, {
      fileContent,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media-files/${mediaFileId}/stream`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/video\/mp4/)
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(res.headers['content-length']).toBe(String(fileContent.length))
    expect(Buffer.from(res.rawPayload)).toEqual(fileContent)
  })

  it('returns 206 for valid Range request', async () => {
    const fileContent = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    const filePath = join(testDir, 'test-range.mp4')
    const { mediaFileId } = await createMediaFixture(db, localNodeId, libraryId, filePath, {
      fileContent,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media-files/${mediaFileId}/stream`,
      headers: { Range: 'bytes=0-9', Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 0-9/${fileContent.length}`)
    expect(res.headers['content-length']).toBe('10')
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(Buffer.from(res.rawPayload).toString()).toBe('ABCDEFGHIJ')
  })

  it('returns 206 for suffix range (bytes=-5)', async () => {
    const fileContent = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    const filePath = join(testDir, 'test-suffix.mp4')
    const { mediaFileId } = await createMediaFixture(db, localNodeId, libraryId, filePath, {
      fileContent,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media-files/${mediaFileId}/stream`,
      headers: { Range: 'bytes=-5', Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(206)
    expect(Buffer.from(res.rawPayload).toString()).toBe('VWXYZ')
  })

  it('returns 416 for invalid range (start beyond file size)', async () => {
    const fileContent = Buffer.from('SHORT')
    const filePath = join(testDir, 'test-416.mp4')
    const { mediaFileId } = await createMediaFixture(db, localNodeId, libraryId, filePath, {
      fileContent,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media-files/${mediaFileId}/stream`,
      headers: { Range: 'bytes=9999-99999', Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(416)
    expect(res.headers['content-range']).toBe(`bytes */${fileContent.length}`)
  })

  it('returns 416 for malformed range header', async () => {
    const fileContent = Buffer.from('HELLO')
    const filePath = join(testDir, 'test-malformed.mp4')
    const { mediaFileId } = await createMediaFixture(db, localNodeId, libraryId, filePath, {
      fileContent,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media-files/${mediaFileId}/stream`,
      headers: { Range: 'bytes=invalid', Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(416)
  })

  it('returns 404 when file exists in DB but not on disk', async () => {
    const filePath = join(testDir, 'ghost-file.mp4')
    const { mediaFileId } = await createMediaFixture(db, localNodeId, libraryId, filePath, {
      writeFile: false,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media-files/${mediaFileId}/stream`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/disk/i)
  })
})

describe('source selection', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let libraryId: string
  let app: ReturnType<typeof buildServer>
  let sessionCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-source-test-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Movies',
      kind: 'movies',
      root_path: testDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    app = buildServer(db, localNodeId, 'http://localhost:3001')
    await app.ready()
    sessionCookie = await setupAuth(app)
  })

  it('returns unavailable when media item has no files', async () => {
    const now = new Date().toISOString()
    const mediaItemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: mediaItemId,
      library_id: libraryId,
      kind: 'movie',
      title: 'No Files Movie',
      sort_title: 'no files movie',
      year: 2020,
      external_tmdb_id: null,
      external_tvdb_id: null,
      external_musicbrainz_id: null,
      created_at: now,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.unavailable).toBe(true)
    expect(body.data.source).toBeUndefined()
  })

  it('returns unavailable when files exist in DB but not on disk', async () => {
    const filePath = join(testDir, 'missing.mp4')
    const { mediaItemId } = await createMediaFixture(db, localNodeId, libraryId, filePath, {
      writeFile: false,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.unavailable).toBe(true)
    expect(body.data.reason).toMatch(/disk/i)
  })

  it('returns source with streamUrl when file exists on disk', async () => {
    const filePath = join(testDir, 'good-file.mp4')
    const { mediaItemId, mediaFileId } = await createMediaFixture(db, localNodeId, libraryId, filePath)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.source).toBeDefined()
    expect(body.data.source.fileId).toBe(mediaFileId)
    expect(body.data.source.streamUrl).toContain(`/api/v1/media-files/${mediaFileId}/stream`)
  })

  it('picks higher resolution file when multiple are available', async () => {
    const now = new Date().toISOString()

    // Create a single media item
    const mediaItemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: mediaItemId,
      library_id: libraryId,
      kind: 'movie',
      title: 'Multi-Res Movie',
      sort_title: 'multi-res movie',
      year: 2023,
      external_tmdb_id: null,
      external_tvdb_id: null,
      external_musicbrainz_id: null,
      created_at: now,
      updated_at: now,
    })

    // 480p version
    const v480Id = crypto.randomUUID()
    await db.insert(mediaVersions).values({
      id: v480Id,
      media_item_id: mediaItemId,
      label: '480p',
      quality_label: '480p',
      resolution_width: 854,
      resolution_height: 480,
      video_codec: null,
      audio_codec: null,
      container: 'mp4',
      duration_seconds: 7200,
      created_at: now,
      updated_at: now,
    })

    // 1080p version
    const v1080Id = crypto.randomUUID()
    await db.insert(mediaVersions).values({
      id: v1080Id,
      media_item_id: mediaItemId,
      label: '1080p',
      quality_label: '1080p',
      resolution_width: 1920,
      resolution_height: 1080,
      video_codec: null,
      audio_codec: null,
      container: 'mp4',
      duration_seconds: 7200,
      created_at: now,
      updated_at: now,
    })

    // Create files on disk
    const file480Path = join(testDir, 'movie-480p.mp4')
    const file1080Path = join(testDir, 'movie-1080p.mp4')
    writeFileSync(file480Path, Buffer.from('480p content'))
    writeFileSync(file1080Path, Buffer.from('1080p content'))

    const file480Id = crypto.randomUUID()
    await db.insert(mediaFiles).values({
      id: file480Id,
      node_id: localNodeId,
      library_id: libraryId,
      media_item_id: mediaItemId,
      media_version_id: v480Id,
      path: file480Path,
      filename: 'movie-480p.mp4',
      extension: '.mp4',
      size_bytes: 12,
      file_hash: null,
      discovered_at: now,
      updated_at: now,
    })

    const file1080Id = crypto.randomUUID()
    await db.insert(mediaFiles).values({
      id: file1080Id,
      node_id: localNodeId,
      library_id: libraryId,
      media_item_id: mediaItemId,
      media_version_id: v1080Id,
      path: file1080Path,
      filename: 'movie-1080p.mp4',
      extension: '.mp4',
      size_bytes: 13,
      file_hash: null,
      discovered_at: now,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.source).toBeDefined()
    // Should prefer 1080p
    expect(body.data.source.fileId).toBe(file1080Id)
    expect(body.data.source.resolution_height).toBe(1080)
  })

  it('returns 404 for unknown media item', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/media/nonexistent-id/playback-source',
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
  })
})

// ─── Refresh metadata on playback-source ──────────────────────────────────────

describe('playback-source refresh metadata', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let libraryId: string
  let app: ReturnType<typeof buildServer>
  let sessionCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-refresh-test-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Movies',
      kind: 'movies',
      root_path: testDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    app = buildServer(db, localNodeId, 'http://localhost:3001')
    await app.ready()
    sessionCookie = await setupAuth(app)
  })

  it('local source response includes expiresAt', async () => {
    const filePath = join(testDir, 'refresh-expires.mp4')
    const { mediaItemId } = await createMediaFixture(db, localNodeId, libraryId, filePath)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.source.expiresAt).toBeDefined()
    const exp = new Date(body.data.source.expiresAt)
    expect(exp.getTime()).toBeGreaterThan(Date.now())
  })

  it('local source response includes refreshAfter that is before expiresAt', async () => {
    const filePath = join(testDir, 'refresh-after.mp4')
    const { mediaItemId } = await createMediaFixture(db, localNodeId, libraryId, filePath)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const src = body.data.source
    expect(src.refreshAfter).toBeDefined()
    const refreshAt = new Date(src.refreshAfter).getTime()
    const expiresAt = new Date(src.expiresAt).getTime()
    expect(refreshAt).toBeGreaterThan(Date.now())
    expect(refreshAt).toBeLessThan(expiresAt)
  })

  it('local source response includes tokenTtlSeconds as a positive integer', async () => {
    const filePath = join(testDir, 'refresh-ttl.mp4')
    const { mediaItemId } = await createMediaFixture(db, localNodeId, libraryId, filePath)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(typeof body.data.source.tokenTtlSeconds).toBe('number')
    expect(body.data.source.tokenTtlSeconds).toBeGreaterThan(0)
  })

  it('unavailable response does not include refresh metadata', async () => {
    // No files → unavailable
    const now = new Date().toISOString()
    const mediaItemId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: mediaItemId,
      library_id: libraryId,
      kind: 'movie',
      title: 'No Files',
      sort_title: 'no files',
      year: 2020,
      external_tmdb_id: null,
      external_tvdb_id: null,
      external_musicbrainz_id: null,
      created_at: now,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.unavailable).toBe(true)
    expect(body.data.expiresAt).toBeUndefined()
    expect(body.data.refreshAfter).toBeUndefined()
    expect(body.data.tokenTtlSeconds).toBeUndefined()
  })

  it('no filesystem path is exposed in the local playback-source response', async () => {
    const filePath = join(testDir, 'no-path-leak.mp4')
    const { mediaItemId } = await createMediaFixture(db, localNodeId, libraryId, filePath)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: sessionCookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const src = body.data.source
    // filePath must not be present in the HTTP response
    expect(src.filePath).toBeUndefined()
    // streamUrl should exist and be a URL (not a raw path)
    expect(src.streamUrl).toMatch(/^https?:\/\//)
  })

  it('repeated calls to playback-source still enforce canPlay permission', async () => {
    const filePath = join(testDir, 'perm-check.mp4')
    const { mediaItemId } = await createMediaFixture(db, localNodeId, libraryId, filePath)

    // First call succeeds with valid session
    const res1 = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: sessionCookie },
    })
    expect(res1.statusCode).toBe(200)
    expect(JSON.parse(res1.body).data.source).toBeDefined()

    // Second call with same session also succeeds
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: sessionCookie },
    })
    expect(res2.statusCode).toBe(200)
    expect(JSON.parse(res2.body).data.source).toBeDefined()

    // Unauthenticated call is rejected
    const res3 = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
    })
    expect(res3.statusCode).toBe(401)
  })
})

describe('playback sessions', () => {
  let testDir: string
  let db: ReturnType<typeof createDb>
  let localNodeId: string
  let libraryId: string
  let app: ReturnType<typeof buildServer>
  let userId: string
  let sessionCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-psession-test-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    // Get the default admin user
    const [user] = await db.select().from(users).limit(1)
    userId = user.id

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Movies',
      kind: 'movies',
      root_path: testDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    app = buildServer(db, localNodeId, 'http://localhost:3001')
    await app.ready()
    sessionCookie = await setupAuth(app)
  })

  async function createSession(mediaItemId: string, mediaVersionId: string, mediaFileId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/playback-sessions',
      headers: { Cookie: sessionCookie },
      payload: { media_item_id: mediaItemId, media_version_id: mediaVersionId, media_file_id: mediaFileId },
    })
  }

  it('creates a playback session and returns 201', async () => {
    const filePath = join(testDir, 'session-test.mp4')
    const { mediaItemId, mediaVersionId, mediaFileId } = await createMediaFixture(
      db, localNodeId, libraryId, filePath
    )

    const res = await createSession(mediaItemId, mediaVersionId, mediaFileId)

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.state).toBe('starting')
    expect(body.data.media_item_id).toBe(mediaItemId)
    expect(body.data.media_file_id).toBe(mediaFileId)
    expect(body.data.node_id).toBe(localNodeId)
  })

  it('updates session state to playing', async () => {
    const filePath = join(testDir, 'session-update.mp4')
    const { mediaItemId, mediaVersionId, mediaFileId } = await createMediaFixture(
      db, localNodeId, libraryId, filePath
    )

    const createRes = await createSession(mediaItemId, mediaVersionId, mediaFileId)
    const sessionId = JSON.parse(createRes.body).data.id

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/playback-sessions/${sessionId}`,
      headers: { Cookie: sessionCookie },
      payload: { state: 'playing' },
    })

    expect(patchRes.statusCode).toBe(200)
    const body = JSON.parse(patchRes.body)
    expect(body.ok).toBe(true)
    expect(body.data.state).toBe('playing')
  })

  it('updates session state to stopped', async () => {
    const filePath = join(testDir, 'session-stop.mp4')
    const { mediaItemId, mediaVersionId, mediaFileId } = await createMediaFixture(
      db, localNodeId, libraryId, filePath
    )

    const createRes = await createSession(mediaItemId, mediaVersionId, mediaFileId)
    const sessionId = JSON.parse(createRes.body).data.id

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/playback-sessions/${sessionId}`,
      headers: { Cookie: sessionCookie },
      payload: { state: 'stopped' },
    })

    expect(patchRes.statusCode).toBe(200)
    const body = JSON.parse(patchRes.body)
    expect(body.data.state).toBe('stopped')
  })

  it('returns 401 when creating session without authentication', async () => {
    const filePath = join(testDir, 'session-noauth.mp4')
    const { mediaItemId, mediaVersionId, mediaFileId } = await createMediaFixture(
      db, localNodeId, libraryId, filePath
    )
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/playback-sessions',
      payload: { media_item_id: mediaItemId, media_version_id: mediaVersionId, media_file_id: mediaFileId },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 400 when required fields are missing on create', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/playback-sessions',
      headers: { Cookie: sessionCookie },
      payload: { media_item_id: 'some-id' },
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
  })

  it('returns 401 when patching session without authentication', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/playback-sessions/nonexistent-id',
      payload: { state: 'paused' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 when patching nonexistent session', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/playback-sessions/nonexistent-id',
      headers: { Cookie: sessionCookie },
      payload: { state: 'paused' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 400 for invalid state on update', async () => {
    const filePath = join(testDir, 'session-invalid.mp4')
    const { mediaItemId, mediaVersionId, mediaFileId } = await createMediaFixture(
      db, localNodeId, libraryId, filePath
    )

    const createRes = await createSession(mediaItemId, mediaVersionId, mediaFileId)
    const sessionId = JSON.parse(createRes.body).data.id

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/playback-sessions/${sessionId}`,
      headers: { Cookie: sessionCookie },
      payload: { state: 'invalid-state' },
    })

    expect(res.statusCode).toBe(400)
  })
})
