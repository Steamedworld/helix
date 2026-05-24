/**
 * Tests for the episode ordering service (Phase 7 — next-episode continuity).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import {
  getOrderedEpisodes,
  getUpNextEpisode,
  getNextEpisode,
  getShowProgress,
} from '../src/services/episodeOrder'
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

// ─── DB helpers ────────────────────────────────────────────────────────────────

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

// ─── Fixture builder ───────────────────────────────────────────────────────────

interface TvFixture {
  showId: string
  /** Array of season ids, index 0 = season 1 */
  seasonIds: string[]
  /** Flat array of episode ids in season/episode order */
  episodeIds: string[]
  /** Node id for creating media_files */
  nodeId: string
  /** Library id */
  libraryId: string
  /** User id */
  userId: string
}

/**
 * Creates show → N seasons → episodesPerSeason episodes each.
 * Episodes do NOT have media_files by default — call addPlayableFile() to add one.
 */
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
    title: 'Test Show',
    sort_title: 'test show',
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

  return {
    showId,
    seasonIds,
    episodeIds,
    nodeId: node.id,
    libraryId,
    userId: user.id,
  }
}

/**
 * Attaches a non-missing media_file to an episode so it appears in ordered results.
 */
async function addPlayableFile(db: TestDb, fixture: TvFixture, episodeId: string) {
  const now = new Date().toISOString()
  const versionId = crypto.randomUUID()
  await db.insert(mediaVersions).values({
    id: versionId,
    media_item_id: episodeId,
    duration_seconds: 2700,
    created_at: now,
    updated_at: now,
  })
  const fileId = crypto.randomUUID()
  await db.insert(mediaFiles).values({
    id: fileId,
    node_id: fixture.nodeId,
    library_id: fixture.libraryId,
    media_item_id: episodeId,
    media_version_id: versionId,
    path: `/media/${episodeId}.mkv`,
    filename: `${episodeId}.mkv`,
    extension: 'mkv',
    missing_at: null,
    discovered_at: now,
    updated_at: now,
  })
  return { versionId, fileId }
}

/**
 * Sets a watch state for the given episode.
 */
async function setWatchState(
  db: TestDb,
  userId: string,
  episodeId: string,
  opts: { position?: number; duration?: number; completed?: boolean }
) {
  const { position = 0, duration = 2700, completed = false } = opts
  const now = new Date().toISOString()

  // Upsert
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

describe('episodeOrder service', () => {
  let testDir: string
  let db: TestDb

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-ep-order-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  // ─── getOrderedEpisodes ────────────────────────────────────────────────────

  describe('getOrderedEpisodes', () => {
    it('returns episodes in season ASC, episode ASC order', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 2, episodesPerSeason: 3 })
      // Add playable files for all episodes
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
      }

      const result = await getOrderedEpisodes(db, fix.showId, fix.userId)
      expect(result).toHaveLength(6)

      // Verify ordering: S1E1, S1E2, S1E3, S2E1, S2E2, S2E3
      expect(result[0].seasonNumber).toBe(1)
      expect(result[0].episodeNumber).toBe(1)
      expect(result[3].seasonNumber).toBe(2)
      expect(result[3].episodeNumber).toBe(1)
      expect(result[5].seasonNumber).toBe(2)
      expect(result[5].episodeNumber).toBe(3)
    })

    it('excludes episodes without a non-missing media_file', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 1, episodesPerSeason: 3 })
      // Only add file for first two episodes
      await addPlayableFile(db, fix, fix.episodeIds[0])
      await addPlayableFile(db, fix, fix.episodeIds[1])
      // Third episode has no file

      const result = await getOrderedEpisodes(db, fix.showId, fix.userId)
      expect(result).toHaveLength(2)
      expect(result[0].episodeNumber).toBe(1)
      expect(result[1].episodeNumber).toBe(2)
    })

    it('includes watch state for episodes', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 1, episodesPerSeason: 2 })
      await addPlayableFile(db, fix, fix.episodeIds[0])
      await addPlayableFile(db, fix, fix.episodeIds[1])
      await setWatchState(db, fix.userId, fix.episodeIds[0], { position: 300, completed: false })

      const result = await getOrderedEpisodes(db, fix.showId, fix.userId)
      expect(result[0].watchState).toBeDefined()
      expect(result[0].watchState?.position).toBe(300)
      expect(result[0].watchState?.completed).toBe(false)
      expect(result[1].watchState).toBeUndefined()
    })

    it('returns empty array for unknown show', async () => {
      await bootstrap(db, testDir)
      const result = await getOrderedEpisodes(db, 'nonexistent', 'user-1')
      expect(result).toHaveLength(0)
    })

    it('uses episode_title when available, else falls back to Episode N', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 1, episodesPerSeason: 1 })
      await addPlayableFile(db, fix, fix.episodeIds[0])

      const result = await getOrderedEpisodes(db, fix.showId, fix.userId)
      // Fixture inserts episode_title like "Episode S1E1"
      expect(result[0].title).toBe('Episode S1E1')
    })
  })

  // ─── getUpNextEpisode ──────────────────────────────────────────────────────

  describe('getUpNextEpisode', () => {
    it('returns first episode when no watch history', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 2, episodesPerSeason: 3 })
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
      }

      const next = await getUpNextEpisode(db, fix.showId, fix.userId)
      expect(next).not.toBeNull()
      expect(next!.seasonNumber).toBe(1)
      expect(next!.episodeNumber).toBe(1)
    })

    it('returns the in-progress episode (position > 0, not completed)', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 2, episodesPerSeason: 3 })
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
      }

      // Mark S1E1 completed, S1E2 in-progress
      await setWatchState(db, fix.userId, fix.episodeIds[0], { completed: true, position: 2700 })
      await setWatchState(db, fix.userId, fix.episodeIds[1], { position: 900, completed: false })

      const next = await getUpNextEpisode(db, fix.showId, fix.userId)
      expect(next).not.toBeNull()
      expect(next!.episodeNumber).toBe(2)
      expect(next!.seasonNumber).toBe(1)
    })

    it('returns the episode after the last completed one (no in-progress)', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 2, episodesPerSeason: 3 })
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
      }

      // Complete first two episodes of season 1
      await setWatchState(db, fix.userId, fix.episodeIds[0], { completed: true, position: 2700 })
      await setWatchState(db, fix.userId, fix.episodeIds[1], { completed: true, position: 2700 })

      const next = await getUpNextEpisode(db, fix.showId, fix.userId)
      expect(next).not.toBeNull()
      expect(next!.seasonNumber).toBe(1)
      expect(next!.episodeNumber).toBe(3)
    })

    it('skips episodes without a playable file when computing up-next', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 1, episodesPerSeason: 4 })
      // Only provide files for episodes 1, 3, 4 (skip ep 2)
      await addPlayableFile(db, fix, fix.episodeIds[0])
      // episodeIds[1] has no file
      await addPlayableFile(db, fix, fix.episodeIds[2])
      await addPlayableFile(db, fix, fix.episodeIds[3])

      // Complete ep 1
      await setWatchState(db, fix.userId, fix.episodeIds[0], { completed: true, position: 2700 })

      // Up-next should skip ep 2 (no file) and return ep 3
      const next = await getUpNextEpisode(db, fix.showId, fix.userId)
      expect(next).not.toBeNull()
      expect(next!.episodeNumber).toBe(3)
    })

    it('returns null when all episodes are completed', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 1, episodesPerSeason: 2 })
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
        await setWatchState(db, fix.userId, epId, { completed: true, position: 2700 })
      }

      const next = await getUpNextEpisode(db, fix.showId, fix.userId)
      expect(next).toBeNull()
    })

    it('returns null when show has no playable episodes', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 1, episodesPerSeason: 3 })
      // No files added → no playable episodes

      const next = await getUpNextEpisode(db, fix.showId, fix.userId)
      expect(next).toBeNull()
    })
  })

  // ─── getNextEpisode ────────────────────────────────────────────────────────

  describe('getNextEpisode', () => {
    it('returns the correct next episode in order', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 2, episodesPerSeason: 3 })
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
      }

      // S1E2 should come after S1E1
      const next = await getNextEpisode(db, fix.episodeIds[0], fix.userId)
      expect(next).not.toBeNull()
      expect(next!.seasonNumber).toBe(1)
      expect(next!.episodeNumber).toBe(2)
    })

    it('returns null when given the last episode', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 1, episodesPerSeason: 3 })
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
      }

      const lastEpId = fix.episodeIds[fix.episodeIds.length - 1]
      const next = await getNextEpisode(db, lastEpId, fix.userId)
      expect(next).toBeNull()
    })

    it('crosses season boundary correctly', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 2, episodesPerSeason: 2 })
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
      }

      // episodeIds order: S1E1(0), S1E2(1), S2E1(2), S2E2(3)
      const lastOfSeason1 = fix.episodeIds[1] // S1E2
      const next = await getNextEpisode(db, lastOfSeason1, fix.userId)
      expect(next).not.toBeNull()
      expect(next!.seasonNumber).toBe(2)
      expect(next!.episodeNumber).toBe(1)
    })

    it('returns null for unknown episode id', async () => {
      await bootstrap(db, testDir)
      const next = await getNextEpisode(db, 'nonexistent', 'user-1')
      expect(next).toBeNull()
    })
  })

  // ─── getShowProgress ───────────────────────────────────────────────────────

  describe('getShowProgress', () => {
    it('returns correct totals when no episodes watched', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 2, episodesPerSeason: 3 })
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
      }

      const progress = await getShowProgress(db, fix.showId, fix.userId)
      expect(progress.totalEpisodes).toBe(6)
      expect(progress.completedEpisodes).toBe(0)
      expect(progress.percentComplete).toBe(0)
      expect(progress.allCompleted).toBe(false)
      expect(progress.inProgressEpisode).toBeNull()
    })

    it('returns correct counts after partial completion', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 1, episodesPerSeason: 10 })
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
      }

      // Complete 7 of 10
      for (let i = 0; i < 7; i++) {
        await setWatchState(db, fix.userId, fix.episodeIds[i], { completed: true, position: 2700 })
      }

      const progress = await getShowProgress(db, fix.showId, fix.userId)
      expect(progress.totalEpisodes).toBe(10)
      expect(progress.completedEpisodes).toBe(7)
      expect(progress.percentComplete).toBe(70)
      expect(progress.allCompleted).toBe(false)
    })

    it('reports allCompleted=true when all episodes are complete', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 1, episodesPerSeason: 3 })
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
        await setWatchState(db, fix.userId, epId, { completed: true, position: 2700 })
      }

      const progress = await getShowProgress(db, fix.showId, fix.userId)
      expect(progress.totalEpisodes).toBe(3)
      expect(progress.completedEpisodes).toBe(3)
      expect(progress.percentComplete).toBe(100)
      expect(progress.allCompleted).toBe(true)
    })

    it('returns inProgressEpisode when one is in-flight', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 1, episodesPerSeason: 3 })
      for (const epId of fix.episodeIds) {
        await addPlayableFile(db, fix, epId)
      }

      await setWatchState(db, fix.userId, fix.episodeIds[0], { completed: true, position: 2700 })
      await setWatchState(db, fix.userId, fix.episodeIds[1], { position: 500, completed: false })

      const progress = await getShowProgress(db, fix.showId, fix.userId)
      expect(progress.inProgressEpisode).not.toBeNull()
      expect(progress.inProgressEpisode!.episodeNumber).toBe(2)
    })

    it('returns percentComplete=0 for show with no playable episodes', async () => {
      const fix = await buildTvFixture(db, testDir, { seasonCount: 1, episodesPerSeason: 3 })
      // No files

      const progress = await getShowProgress(db, fix.showId, fix.userId)
      expect(progress.totalEpisodes).toBe(0)
      expect(progress.percentComplete).toBe(0)
      expect(progress.allCompleted).toBe(false)
    })
  })
})
