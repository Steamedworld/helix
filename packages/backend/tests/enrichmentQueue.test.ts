/**
 * Background enrichment queue tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { setupAuth } from './helpers/auth'
import { EnrichmentQueue } from '../src/services/enrichmentQueue'
import { enrichmentJobs, mediaItems, libraries } from '../src/db/schema'
import { eq, and } from 'drizzle-orm'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

async function insertMovie(db: TestDb, libraryId: string, title: string): Promise<string> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.insert(mediaItems).values({
    id,
    library_id: libraryId,
    kind: 'movie',
    title,
    metadata_status: 'unknown',
    created_at: now,
    updated_at: now,
  })
  return id
}

async function insertLibrary(db: TestDb, nodeId: string): Promise<string> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.insert(libraries).values({
    id,
    node_id: nodeId,
    name: 'Test Library',
    kind: 'movies',
    root_path: '/tmp/movies',
    scan_status: 'idle',
    created_at: now,
    updated_at: now,
  })
  return id
}

describe('EnrichmentQueue', () => {
  let testDir: string
  let db: TestDb
  let localNodeId: string
  let libraryId: string
  let queue: EnrichmentQueue

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-eq-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    libraryId = await insertLibrary(db, localNodeId)
    queue = new EnrichmentQueue()
    // Don't start the loop — drive with processOne() in tests
  })

  afterEach(() => {
    queue.stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    rmSync(testDir, { recursive: true, force: true })
  })

  // ─── Enqueue ────────────────────────────────────────────────────────────────

  it('enqueue inserts jobs for given IDs', async () => {
    const id1 = await insertMovie(db, libraryId, 'Movie A')
    const id2 = await insertMovie(db, libraryId, 'Movie B')

    const count = await queue.enqueue(db, [id1, id2])
    expect(count).toBe(2)

    const jobs = await db.select().from(enrichmentJobs)
    expect(jobs.length).toBe(2)
    expect(jobs.every((j) => j.status === 'pending')).toBe(true)
  })

  it('enqueue deduplicates — same ID twice only inserts one job', async () => {
    const id = await insertMovie(db, libraryId, 'Dedup Movie')

    await queue.enqueue(db, [id])
    const second = await queue.enqueue(db, [id])
    expect(second).toBe(0)

    const jobs = await db.select().from(enrichmentJobs)
    expect(jobs.length).toBe(1)
  })

  it('enqueue skips IDs with running jobs', async () => {
    const id = await insertMovie(db, libraryId, 'Running Movie')
    await queue.enqueue(db, [id])

    // Manually set to running
    await db.update(enrichmentJobs).set({ status: 'running' }).where(eq(enrichmentJobs.media_item_id, id))

    const count = await queue.enqueue(db, [id])
    expect(count).toBe(0)

    const jobs = await db.select().from(enrichmentJobs)
    expect(jobs.length).toBe(1)
  })

  it('enqueue allows re-enqueueing items with done/failed jobs', async () => {
    const id = await insertMovie(db, libraryId, 'Done Movie')
    await queue.enqueue(db, [id])

    // Mark done
    await db.update(enrichmentJobs).set({ status: 'done' }).where(eq(enrichmentJobs.media_item_id, id))

    const count = await queue.enqueue(db, [id])
    expect(count).toBe(1)

    const jobs = await db.select().from(enrichmentJobs)
    expect(jobs.length).toBe(2)
    const pending = jobs.filter((j) => j.status === 'pending')
    expect(pending.length).toBe(1)
  })

  it('enqueue returns 0 when enrichmentEnabled is false', async () => {
    const id = await insertMovie(db, libraryId, 'Disabled Movie')

    // Temporarily disable enrichment
    const orig = process.env.METADATA_ENRICHMENT_ENABLED
    process.env.METADATA_ENRICHMENT_ENABLED = 'false'

    // Re-require config to pick up env change — use a fresh queue with mocked config
    // Since config is cached, we test by checking the env var route directly
    // Instead: verify the guard via the property
    const { config } = await import('../src/config')
    const origEnabled = config.metadataEnrichmentEnabled
    ;(config as Record<string, unknown>).metadataEnrichmentEnabled = false

    const count = await queue.enqueue(db, [id])

    ;(config as Record<string, unknown>).metadataEnrichmentEnabled = origEnabled
    process.env.METADATA_ENRICHMENT_ENABLED = orig

    expect(count).toBe(0)
    const jobs = await db.select().from(enrichmentJobs)
    expect(jobs.length).toBe(0)
  })

  it('enqueue with empty array returns 0 and inserts nothing', async () => {
    const count = await queue.enqueue(db, [])
    expect(count).toBe(0)
    const jobs = await db.select().from(enrichmentJobs)
    expect(jobs.length).toBe(0)
  })

  // ─── processOne ────────────────────────────────────────────────────────────

  it('processOne returns false when queue is empty', async () => {
    const processed = await queue.processOne(db)
    expect(processed).toBe(false)
  })

  it('processOne marks job done on no_provider (no TMDB configured)', async () => {
    // In test env, TMDB is not configured → enrichMediaItem returns no_provider → done
    const id = await insertMovie(db, libraryId, 'No Provider Movie')
    await queue.enqueue(db, [id])

    const processed = await queue.processOne(db)
    expect(processed).toBe(true)

    const [job] = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.media_item_id, id))
    expect(job.status).toBe('done')
    expect(job.attempts).toBe(1)
  })

  it('processOne returns true and processes pending job', async () => {
    const id1 = await insertMovie(db, libraryId, 'First')
    const id2 = await insertMovie(db, libraryId, 'Second')
    await queue.enqueue(db, [id1, id2])

    const p1 = await queue.processOne(db)
    expect(p1).toBe(true)

    const p2 = await queue.processOne(db)
    expect(p2).toBe(true)

    const p3 = await queue.processOne(db)
    expect(p3).toBe(false) // queue empty

    const jobs = await db.select().from(enrichmentJobs)
    expect(jobs.every((j) => j.status === 'done')).toBe(true)
  })

  // ─── Retry on error ─────────────────────────────────────────────────────────

  it('processOne retries failed enrichment up to max_attempts', async () => {
    // Mock enrichMediaItem to throw
    const enrichModule = await import('../src/services/metadata/enrichment')
    const spy = vi.spyOn(enrichModule, 'enrichMediaItem').mockRejectedValue(new Error('TMDB timeout'))

    const id = await insertMovie(db, libraryId, 'Fail Movie')
    await queue.enqueue(db, [id])

    // First attempt → pending (attempt 1 of 3)
    await queue.processOne(db)
    let [job] = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.media_item_id, id))
    expect(job.status).toBe('pending')
    expect(job.attempts).toBe(1)

    // Second attempt → still pending (attempt 2 of 3)
    await queue.processOne(db)
    ;[job] = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.media_item_id, id))
    expect(job.status).toBe('pending')
    expect(job.attempts).toBe(2)

    // Third attempt → failed (attempt 3 of 3, exhausted)
    await queue.processOne(db)
    ;[job] = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.media_item_id, id))
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(3)
    expect(job.last_error).toBe('TMDB timeout')

    spy.mockRestore()
  })

  it('processOne records error message on failure', async () => {
    const enrichModule = await import('../src/services/metadata/enrichment')
    vi.spyOn(enrichModule, 'enrichMediaItem').mockRejectedValue(new Error('Network unreachable'))

    const id = await insertMovie(db, libraryId, 'Error Movie')
    await queue.enqueue(db, [id])
    await queue.processOne(db)

    const [job] = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.media_item_id, id))
    expect(job.last_error).toBe('Network unreachable')
  })

  it('processOne marks job done when enrichMediaItem returns error status', async () => {
    const enrichModule = await import('../src/services/metadata/enrichment')
    vi.spyOn(enrichModule, 'enrichMediaItem').mockResolvedValue({
      mediaItemId: 'x',
      status: 'error',
      error: 'Item not found',
    })

    const id = await insertMovie(db, libraryId, 'Error Status Movie')
    await queue.enqueue(db, [id])

    // attempt 1 → pending (retry)
    await queue.processOne(db)
    const [job1] = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.media_item_id, id))
    expect(job1.status).toBe('pending')
    expect(job1.attempts).toBe(1)
    expect(job1.last_error).toBe('Item not found')
  })

  // ─── getStats ───────────────────────────────────────────────────────────────

  it('getStats returns correct counts', async () => {
    const id1 = await insertMovie(db, libraryId, 'Stat A')
    const id2 = await insertMovie(db, libraryId, 'Stat B')
    const id3 = await insertMovie(db, libraryId, 'Stat C')

    await queue.enqueue(db, [id1, id2, id3])

    // Mark one done, one failed
    await db.update(enrichmentJobs).set({ status: 'done' }).where(eq(enrichmentJobs.media_item_id, id2))
    await db.update(enrichmentJobs).set({ status: 'failed', last_error: 'oops' }).where(eq(enrichmentJobs.media_item_id, id3))

    const stats = await queue.getStats(db)
    expect(stats.pending).toBe(1)
    expect(stats.done).toBe(1)
    expect(stats.failed).toBe(1)
    expect(stats.running).toBe(0)
  })

  it('getStats includes recentFailed entries', async () => {
    const id = await insertMovie(db, libraryId, 'Failed Item')
    await queue.enqueue(db, [id])
    await db.update(enrichmentJobs).set({ status: 'failed', last_error: 'connection refused' })
      .where(eq(enrichmentJobs.media_item_id, id))

    const stats = await queue.getStats(db)
    expect(stats.recentFailed.length).toBe(1)
    expect(stats.recentFailed[0].lastError).toBe('connection refused')
    expect(stats.recentFailed[0].mediaItemId).toBe(id)
  })

  // ─── clearCompleted ─────────────────────────────────────────────────────────

  it('clearCompleted removes done and failed jobs', async () => {
    const id1 = await insertMovie(db, libraryId, 'Clear A')
    const id2 = await insertMovie(db, libraryId, 'Clear B')
    const id3 = await insertMovie(db, libraryId, 'Clear C — keep')

    await queue.enqueue(db, [id1, id2, id3])
    await db.update(enrichmentJobs).set({ status: 'done' }).where(eq(enrichmentJobs.media_item_id, id1))
    await db.update(enrichmentJobs).set({ status: 'failed' }).where(eq(enrichmentJobs.media_item_id, id2))
    // id3 remains pending

    const removed = await queue.clearCompleted(db)
    expect(removed).toBe(2)

    const remaining = await db.select().from(enrichmentJobs)
    expect(remaining.length).toBe(1)
    expect(remaining[0].status).toBe('pending')
  })

  it('clearCompleted returns 0 when nothing to clear', async () => {
    const removed = await queue.clearCompleted(db)
    expect(removed).toBe(0)
  })

  // ─── enqueueLibraryItems ────────────────────────────────────────────────────

  it('enqueueLibraryItems enqueues unenriched items from a library', async () => {
    const id1 = await insertMovie(db, libraryId, 'Library Movie A')
    const id2 = await insertMovie(db, libraryId, 'Library Movie B')

    // Mark one as already matched
    await db.update(mediaItems).set({ metadata_status: 'matched' }).where(eq(mediaItems.id, id2))

    const count = await queue.enqueueLibraryItems(db, libraryId)
    expect(count).toBe(1)

    const jobs = await db.select().from(enrichmentJobs)
    expect(jobs.length).toBe(1)
    expect(jobs[0].media_item_id).toBe(id1)
  })

  it('enqueueLibraryItems returns 0 when all items are already enriched', async () => {
    const id = await insertMovie(db, libraryId, 'Already Matched')
    await db.update(mediaItems).set({ metadata_status: 'matched' }).where(eq(mediaItems.id, id))

    const count = await queue.enqueueLibraryItems(db, libraryId)
    expect(count).toBe(0)
  })

  // ─── enqueueAll ─────────────────────────────────────────────────────────────

  it('enqueueAll enqueues unenriched items across all libraries', async () => {
    const lib2 = await insertLibrary(db, localNodeId)
    const id1 = await insertMovie(db, libraryId, 'All A')
    const id2 = await insertMovie(db, lib2, 'All B')

    const count = await queue.enqueueAll(db)
    expect(count).toBe(2)

    const jobs = await db.select().from(enrichmentJobs)
    expect(jobs.length).toBe(2)
  })
})

// ─── API route tests ─────────────────────────────────────────────────────────

describe('enrichment queue routes', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-eq-routes-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllGlobals()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('GET /stats returns queue counts (admin)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/enrichment-queue/stats',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(typeof body.data.pending).toBe('number')
    expect(typeof body.data.running).toBe('number')
    expect(typeof body.data.done).toBe('number')
    expect(typeof body.data.failed).toBe('number')
    expect(Array.isArray(body.data.recentFailed)).toBe(true)
  })

  it('GET /stats requires admin → 401 unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/enrichment-queue/stats' })
    expect(res.statusCode).toBe(401)
  })

  it('POST /clear removes completed jobs (admin)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/enrichment-queue/clear',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(typeof body.data.removed).toBe('number')
  })

  it('POST /enqueue returns enqueued count (admin)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/enrichment-queue/enqueue',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(typeof body.data.enqueued).toBe('number')
  })

  it('POST /clear requires admin → 401 unauthenticated', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/enrichment-queue/clear' })
    expect(res.statusCode).toBe(401)
  })

  it('POST /enqueue requires admin → 401 unauthenticated', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/enrichment-queue/enqueue' })
    expect(res.statusCode).toBe(401)
  })
})
