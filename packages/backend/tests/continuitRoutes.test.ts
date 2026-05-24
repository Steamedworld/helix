/**
 * Integration tests for next-episode continuity API routes (Phase 7).
 *
 * Routes under test:
 *   GET /api/v1/shows/:id/up-next
 *   GET /api/v1/shows/:id/progress
 *   GET /api/v1/episodes/:id/next
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import {
  libraries,
  mediaItems,
  mediaVersions,
  mediaFiles,
  nodes,
  users,
  watchStates,
} from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

// ─── DB + fixture helpers ──────────────────────────────────────────────────────

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

interface TvFixture {
  showId: string
  seasonIds: string[]
  episodeIds: string[]
  nodeId: string
  libraryId: string
  userId: string
}

async function buildTvFixture(
  db: TestDb,
  testDir: string,
  opts: { seasonCount?: number; episodesPerSeason?: number } = {}
): Promise<TvFixture> {
  const { seasonCount = 2, episodesPerSeason = 3 } = opts
  const localNodeId = await bootstrap(db, testDir)

  const [user] = await db.select().from(users).limit(1)
  const [node] = await db.select().from(nodes).limit(1)

  const now = new Date().toISOString()
  const libraryId = crypto.randomUUID()
  await db.insert(libraries).values({
    id: libraryId,
    node_id: localNodeId,
    name: 'TV Shows',
    kind: 'tv',
    root_path: testDir,
    scan_status: 'idle',
    created_at: now,
    updated_at: now,
  })

  const showId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: showId,
    library_id: libraryId,
    kind: 'show',
    title: 'Breaking Bad',
    sort_title: 'breaking bad',
    metadata_status: 'local',
    metadata_source: 'filename',
    created_at: now,
    updated_at: now,
  })

  const seasonIds: string[] = []
  const episodeIds: string[] = []

  for (let s = 1; s <= seasonCount; s++) {
    const seasonId = crypto.randomUUID()
    await db.insert(mediaItems).values({
      id: seasonId,
      library_id: libraryId,
      parent_id: showId,
      kind: 'season',
      title: `Season ${s}`,
      sort_title: `season ${String(s).padStart(2, '0')}`,
      season_number: s,
      metadata_status: 'local',
      metadata_source: 'filename',
      created_at: now,
      updated_at: now,
    })
    seasonIds.push(seasonId)

    for (let e = 1; e <= episodesPerSeason; e++) {
      const epId = crypto.randomUUID()
      await db.insert(mediaItems).values({
        id: epId,
        library_id: libraryId,
        parent_id: seasonId,
        kind: 'episode',
        title: `S${s}E${e}`,
        sort_title: `s${String(s).padStart(2, '0')}e${String(e).padStart(3, '0')}`,
        season_number: s,
        episode_number: e,
        episode_title: `Episode S${s}E${e}`,
        runtime_seconds: 2700,
        metadata_status: 'local',
        metadata_source: 'filename',
        created_at: now,
        updated_at: now,
      })
      episodeIds.push(epId)
    }
  }

  return { showId, seasonIds, episodeIds, nodeId: node.id, libraryId, userId: user.id }
}

async function addPlayableFile(db: TestDb, fix: TvFixture, episodeId: string) {
  const now = new Date().toISOString()
  const versionId = crypto.randomUUID()
  await db.insert(mediaVersions).values({
    id: versionId,
    media_item_id: episodeId,
    duration_seconds: 2700,
    created_at: now,
    updated_at: now,
  })
  await db.insert(mediaFiles).values({
    id: crypto.randomUUID(),
    node_id: fix.nodeId,
    library_id: fix.libraryId,
    media_item_id: episodeId,
    media_version_id: versionId,
    path: `/media/${episodeId}.mkv`,
    filename: `${episodeId}.mkv`,
    extension: 'mkv',
    missing_at: null,
    discovered_at: now,
    updated_at: now,
  })
}

async function setWatchState(
  db: TestDb,
  userId: string,
  episodeId: string,
  opts: { position?: number; duration?: number; completed?: boolean }
) {
  const { position = 0, duration = 2700, completed = false } = opts
  const now = new Date().toISOString()

  const [existing] = await db
    .select()
    .from(watchStates)
    .where(eq(watchStates.media_item_id, episodeId))
    .limit(1)

  if (existing) {
    await db
      .update(watchStates)
      .set({ position_seconds: position, duration_seconds: duration, completed, updated_at: now })
      .where(eq(watchStates.id, existing.id))
  } else {
    await db.insert(watchStates).values({
      id: crypto.randomUUID(),
      user_id: userId,
      media_item_id: episodeId,
      position_seconds: position,
      duration_seconds: duration,
      completed,
      updated_at: now,
    })
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('continuity routes', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let fix: TvFixture

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-continuity-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    fix = await buildTvFixture(db, testDir, { seasonCount: 2, episodesPerSeason: 3 })
    app = buildServer(db, (await db.select({ id: nodes.id }).from(nodes).limit(1))[0].id)
    await app.ready()

    // Add playable files for all episodes by default
    for (const epId of fix.episodeIds) {
      await addPlayableFile(db, fix, epId)
    }
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  // ─── GET /api/v1/shows/:id/up-next ────────────────────────────────────────

  describe('GET /api/v1/shows/:id/up-next', () => {
    it('returns the first episode when no watch history', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/shows/${fix.showId}/up-next`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data.episode).toBeDefined()
      expect(body.data.episode.seasonNumber).toBe(1)
      expect(body.data.episode.episodeNumber).toBe(1)
      expect(body.data.episode.showId).toBe(fix.showId)
    })

    it('returns allCompleted=true when all episodes are done', async () => {
      for (const epId of fix.episodeIds) {
        await setWatchState(db, fix.userId, epId, { completed: true, position: 2700 })
      }

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/shows/${fix.showId}/up-next`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data.allCompleted).toBe(true)
      expect(body.data.totalEpisodes).toBe(6)
      expect(body.data.episode).toBeUndefined()
    })

    it('returns 404 for unknown show', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/shows/nonexistent/up-next',
      })
      expect(res.statusCode).toBe(404)
    })

    it('returns the in-progress episode when one exists', async () => {
      await setWatchState(db, fix.userId, fix.episodeIds[0], { completed: true, position: 2700 })
      await setWatchState(db, fix.userId, fix.episodeIds[1], { position: 600, completed: false })

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/shows/${fix.showId}/up-next`,
      })
      const body = JSON.parse(res.body)
      expect(body.data.episode.episodeNumber).toBe(2)
    })
  })

  // ─── GET /api/v1/shows/:id/progress ───────────────────────────────────────

  describe('GET /api/v1/shows/:id/progress', () => {
    it('returns correct progress data', async () => {
      // Watch 2 of 6 episodes
      await setWatchState(db, fix.userId, fix.episodeIds[0], { completed: true, position: 2700 })
      await setWatchState(db, fix.userId, fix.episodeIds[1], { completed: true, position: 2700 })

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/shows/${fix.showId}/progress`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data.totalEpisodes).toBe(6)
      expect(body.data.completedEpisodes).toBe(2)
      expect(body.data.percentComplete).toBe(33)
      expect(body.data.allCompleted).toBe(false)
      expect(body.data.inProgressEpisode).toBeNull()
    })

    it('returns allCompleted=true when finished', async () => {
      for (const epId of fix.episodeIds) {
        await setWatchState(db, fix.userId, epId, { completed: true, position: 2700 })
      }

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/shows/${fix.showId}/progress`,
      })
      const body = JSON.parse(res.body)
      expect(body.data.allCompleted).toBe(true)
      expect(body.data.percentComplete).toBe(100)
    })

    it('returns 404 for unknown show', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/shows/nonexistent/progress',
      })
      expect(res.statusCode).toBe(404)
    })
  })

  // ─── GET /api/v1/episodes/:id/next ────────────────────────────────────────

  describe('GET /api/v1/episodes/:id/next', () => {
    it('returns the next episode in sequence', async () => {
      const firstEpId = fix.episodeIds[0] // S1E1

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/episodes/${firstEpId}/next`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data.episode).toBeDefined()
      expect(body.data.episode.episodeNumber).toBe(2)
      expect(body.data.episode.seasonNumber).toBe(1)
    })

    it('crosses season boundary correctly', async () => {
      // fix.episodeIds: S1E1(0), S1E2(1), S1E3(2), S2E1(3), S2E2(4), S2E3(5)
      const lastS1 = fix.episodeIds[2] // S1E3

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/episodes/${lastS1}/next`,
      })
      const body = JSON.parse(res.body)
      expect(body.data.episode.seasonNumber).toBe(2)
      expect(body.data.episode.episodeNumber).toBe(1)
    })

    it('returns 404 when given the last episode', async () => {
      const lastEpId = fix.episodeIds[fix.episodeIds.length - 1]

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/episodes/${lastEpId}/next`,
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(false)
    })

    it('returns 404 for unknown episode id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/episodes/nonexistent/next',
      })
      expect(res.statusCode).toBe(404)
    })
  })
})
