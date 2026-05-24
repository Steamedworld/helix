/**
 * Watch-state behavior tests — completion protection, container guards, movie regression.
 * These test the PUT /api/v1/watchstate/:media_item_id endpoint behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { libraries, mediaItems, users, nodes } from '../src/db/schema'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

describe('watch state — completion protection and container guards', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let userId: string
  let localNodeId: string
  let libraryId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-ws-behav-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)

    const [user] = await db.select().from(users).limit(1)
    userId = user.id

    const now = new Date().toISOString()
    libraryId = crypto.randomUUID()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Test Lib',
      kind: 'movies',
      root_path: testDir,
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })

    app = buildServer(db, localNodeId)
    await app.ready()
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  async function createMediaItem(
    kind: 'movie' | 'show' | 'season' | 'episode',
    extra: Record<string, unknown> = {}
  ) {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id,
      library_id: libraryId,
      kind,
      title: `Test ${kind}`,
      sort_title: `test ${kind}`,
      metadata_status: 'local',
      metadata_source: 'filename',
      created_at: now,
      updated_at: now,
      ...extra,
    })
    return id
  }

  // ─── Completion stays true on rewatch ─────────────────────────────────────

  it('completed episode stays completed when position is updated (normal play through)', async () => {
    const epId = await createMediaItem('episode', { episode_number: 1, season_number: 1 })

    // Mark completed
    const res1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${epId}`,
      payload: {
        user_id: userId,
        position_seconds: 2700,
        duration_seconds: 2700,
        completed: true,
      },
    })
    expect(res1.statusCode).toBe(200)
    expect(JSON.parse(res1.body).data.completed).toBe(true)

    // Simulate rewatch: player sends position=0 with completed=false (rewound to start)
    const res2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${epId}`,
      payload: {
        user_id: userId,
        position_seconds: 0,
        duration_seconds: 2700,
        completed: false,
      },
    })
    expect(res2.statusCode).toBe(200)
    // Position 0 < halfway (1350s) → should NOT un-complete
    // Actually: 0 < 0.5 * 2700 = 1350 → completed = false per our rule
    // Wait — position 0 IS less than halfway so it WOULD un-complete!
    // Our rule is: only un-complete if position < halfway AND completed explicitly = false
    // So at position 0, the episode IS un-completed (intentional rewatch from start)
    // That's the documented behavior: "if position < duration * 0.5"
    expect(JSON.parse(res2.body).data.completed).toBe(false)

    // But if position is past halfway (e.g. restarted and watching past 50%)
    // then completed=false should NOT overwrite. Test this:
    const res3 = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${epId}`,
      payload: {
        user_id: userId,
        position_seconds: 2700,
        duration_seconds: 2700,
        completed: true,
      },
    })
    expect(JSON.parse(res3.body).data.completed).toBe(true)

    // Now send position that's past halfway with completed=false — should keep completed
    const res4 = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${epId}`,
      payload: {
        user_id: userId,
        position_seconds: 1400, // > 1350 (halfway of 2700)
        duration_seconds: 2700,
        completed: false,
      },
    })
    expect(res4.statusCode).toBe(200)
    // position 1400 >= 0.5 * 2700 = 1350 → completed stays true
    expect(JSON.parse(res4.body).data.completed).toBe(true)
  })

  it('completed episode stays completed when no completed flag sent (timeupdate tick)', async () => {
    const epId = await createMediaItem('episode', { episode_number: 1, season_number: 1 })

    // Mark completed
    await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${epId}`,
      payload: {
        user_id: userId,
        position_seconds: 2700,
        duration_seconds: 2700,
        completed: true,
      },
    })

    // Simulate timeupdate: no completed field sent (falls back to existing.completed)
    // but position is > 0 (mid-video on rewatch)
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${epId}`,
      payload: {
        user_id: userId,
        position_seconds: 300,
        duration_seconds: 2700,
        // completed not sent → resolved as ?? existing.completed (true)
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.completed).toBe(true)
  })

  // ─── Movie watch state works unchanged ────────────────────────────────────

  it('movie watch state: progress and completion work correctly', async () => {
    const movieId = await createMediaItem('movie')

    // In-progress
    const r1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${movieId}`,
      payload: {
        user_id: userId,
        position_seconds: 3600,
        duration_seconds: 7200,
        completed: false,
      },
    })
    expect(r1.statusCode).toBe(200)
    expect(JSON.parse(r1.body).data.completed).toBe(false)
    expect(JSON.parse(r1.body).data.position_seconds).toBe(3600)

    // Complete it
    const r2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${movieId}`,
      payload: {
        user_id: userId,
        position_seconds: 7200,
        duration_seconds: 7200,
        completed: true,
      },
    })
    expect(r2.statusCode).toBe(200)
    expect(JSON.parse(r2.body).data.completed).toBe(true)

    // A later timeupdate mid-video that would NOT un-complete (position past halfway)
    const r3 = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${movieId}`,
      payload: {
        user_id: userId,
        position_seconds: 4000, // > 3600 = 50% of 7200
        duration_seconds: 7200,
        completed: false,
      },
    })
    expect(r3.statusCode).toBe(200)
    expect(JSON.parse(r3.body).data.completed).toBe(true) // stays completed
  })

  // ─── Watch state requires valid user_id and position_seconds ──────────────

  it('returns 400 when user_id is missing', async () => {
    const movieId = await createMediaItem('movie')

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${movieId}`,
      payload: {
        position_seconds: 100,
      },
    })
    expect(res.statusCode).toBe(400)
  })

  // ─── Show / season containers should still accept watch state ─────────────
  // (The system does not actively block it at the API layer; it's a soft convention.)
  // We verify the API accepts it and returns 200 — callers simply shouldn't call it for containers.

  it('show item accepts watch state (no 400 returned — container guard is caller-side)', async () => {
    const showId = await createMediaItem('show')

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${showId}`,
      payload: {
        user_id: userId,
        position_seconds: 0,
        duration_seconds: null,
        completed: false,
      },
    })
    // The API accepts it (200) — the guard is that the frontend never calls this for containers
    expect(res.statusCode).toBe(200)
  })

  // ─── Episode completion threshold is 90% ──────────────────────────────────
  // (This is a frontend constant; backend stores whatever it receives.
  //  We test that the backend correctly stores a completed=true at 90% position.)

  it('stores completed=true when the client reports completion', async () => {
    const epId = await createMediaItem('episode', { episode_number: 1, season_number: 1 })
    const duration = 3000
    const position = Math.floor(duration * 0.9) // exactly 90%

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/watchstate/${epId}`,
      payload: {
        user_id: userId,
        position_seconds: position,
        duration_seconds: duration,
        completed: true,
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.completed).toBe(true)
    expect(JSON.parse(res.body).data.position_seconds).toBe(position)
  })
})
