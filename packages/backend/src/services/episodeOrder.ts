/**
 * Episode ordering service — next-episode continuity (Phase 7).
 *
 * Rules:
 * - Only episodes with at least one media_file where missing_at IS NULL are
 *   considered "playable". Episodes with no non-missing files are skipped in
 *   ordering queries.
 * - "In progress" = has watch_state, completed=false, position_seconds > 0.
 * - "Up next" precedence:
 *     1. In-progress episode (not completed, position > 0)
 *     2. First uncompleted episode after the last completed episode
 *     3. If nothing completed, the first playable episode
 *     4. If all completed, return null
 */

import { eq, and, isNull, sql } from 'drizzle-orm'
import { mediaItems, mediaFiles, watchStates } from '../db/schema'
import type { DrizzleDB } from '../db/client'

// ─── Public types ──────────────────────────────────────────────────────────────

export interface PlayableEpisode {
  id: string
  showId: string
  showTitle: string
  seasonId: string
  seasonNumber: number
  episodeNumber: number
  title: string           // episode_title if set, else 'Episode N'
  overview?: string
  airDate?: string
  runtimeSeconds?: number
  posterUrl: string | null
  watchState?: {
    position: number
    duration: number
    completed: boolean
    updatedAt: number
  }
  hasPlayableFile: boolean
}

export interface ShowProgress {
  totalEpisodes: number
  completedEpisodes: number
  inProgressEpisode: PlayableEpisode | null
  percentComplete: number   // 0-100, integer
  allCompleted: boolean
}

// ─── Internal row type from the join ─────────────────────────────────────────

interface EpisodeRow {
  id: string
  parent_id: string | null   // season id
  season_number: number | null
  episode_number: number | null
  episode_title: string | null
  title: string
  overview: string | null
  release_date: string | null
  runtime_seconds: number | null
  poster_path: string | null
  // Watch state fields (left-joined)
  ws_position: number | null
  ws_duration: number | null
  ws_completed: number | null   // SQLite boolean → 0/1
  ws_updated_at: string | null
}

// ─── Artwork URL helper ────────────────────────────────────────────────────────

function artworkUrl(
  mediaItemId: string,
  hasPosterPath: boolean,
  baseUrl: string | null | undefined
): string | null {
  if (!hasPosterPath) return null
  const base = baseUrl ?? ''
  return `${base}/api/v1/media/${mediaItemId}/artwork/poster`
}

// ─── Build PlayableEpisode from a row ─────────────────────────────────────────

function buildPlayableEpisode(
  row: EpisodeRow,
  showId: string,
  showTitle: string,
  hasPlayableFile: boolean,
  baseUrl?: string | null
): PlayableEpisode {
  const episodeTitle =
    row.episode_title ?? `Episode ${row.episode_number ?? 0}`

  let watchState: PlayableEpisode['watchState'] | undefined
  if (
    row.ws_position !== null &&
    row.ws_duration !== null
  ) {
    watchState = {
      position: row.ws_position,
      duration: row.ws_duration,
      completed: row.ws_completed === 1,
      updatedAt: row.ws_updated_at
        ? new Date(row.ws_updated_at).getTime()
        : 0,
    }
  } else if (row.ws_position !== null) {
    // position saved but no duration yet
    watchState = {
      position: row.ws_position,
      duration: 0,
      completed: row.ws_completed === 1,
      updatedAt: row.ws_updated_at
        ? new Date(row.ws_updated_at).getTime()
        : 0,
    }
  }

  return {
    id: row.id,
    showId,
    showTitle,
    seasonId: row.parent_id ?? '',
    seasonNumber: row.season_number ?? 0,
    episodeNumber: row.episode_number ?? 0,
    title: episodeTitle,
    overview: row.overview ?? undefined,
    airDate: row.release_date ?? undefined,
    runtimeSeconds: row.runtime_seconds ?? undefined,
    posterUrl: artworkUrl(row.id, !!row.poster_path, baseUrl),
    watchState,
    hasPlayableFile,
  }
}

// ─── getOrderedEpisodes ───────────────────────────────────────────────────────

/**
 * Returns all playable episodes for a show ordered by season ASC, episode ASC.
 * An episode is "playable" if at least one media_file row has missing_at IS NULL.
 * Watch state for the given userId is left-joined.
 */
export async function getOrderedEpisodes(
  db: DrizzleDB,
  showId: string,
  userId: string,
  baseUrl?: string | null
): Promise<PlayableEpisode[]> {
  // Fetch show
  const [show] = await db
    .select({ id: mediaItems.id, title: mediaItems.title })
    .from(mediaItems)
    .where(and(eq(mediaItems.id, showId), eq(mediaItems.kind, 'show')))
  if (!show) return []

  // Fetch all seasons
  const seasons = await db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(and(eq(mediaItems.parent_id, showId), eq(mediaItems.kind, 'season')))

  const seasonIds = seasons.map((s) => s.id)
  if (seasonIds.length === 0) return []

  // Fetch all episode rows for the show's seasons
  // We use raw SQL for the multi-value IN since Drizzle's inArray is available
  const { inArray } = await import('drizzle-orm')
  const episodes = await db
    .select({
      id: mediaItems.id,
      parent_id: mediaItems.parent_id,
      season_number: mediaItems.season_number,
      episode_number: mediaItems.episode_number,
      episode_title: mediaItems.episode_title,
      title: mediaItems.title,
      overview: mediaItems.overview,
      release_date: mediaItems.release_date,
      runtime_seconds: mediaItems.runtime_seconds,
      poster_path: mediaItems.poster_path,
    })
    .from(mediaItems)
    .where(and(
      inArray(mediaItems.parent_id, seasonIds),
      eq(mediaItems.kind, 'episode')
    ))
    .orderBy(
      sql`${mediaItems.season_number} ASC`,
      sql`${mediaItems.episode_number} ASC`
    )

  if (episodes.length === 0) return []

  // Determine which episodes have a non-missing file
  const episodeIds = episodes.map((e) => e.id)
  const playableFileRows = await db
    .select({ media_item_id: mediaFiles.media_item_id })
    .from(mediaFiles)
    .where(and(
      inArray(mediaFiles.media_item_id, episodeIds),
      isNull(mediaFiles.missing_at)
    ))

  const playableSet = new Set(playableFileRows.map((r) => r.media_item_id))

  // Fetch watch states
  const watchStateRows = await db
    .select({
      media_item_id: watchStates.media_item_id,
      position_seconds: watchStates.position_seconds,
      duration_seconds: watchStates.duration_seconds,
      completed: watchStates.completed,
      updated_at: watchStates.updated_at,
    })
    .from(watchStates)
    .where(and(
      eq(watchStates.user_id, userId),
      inArray(watchStates.media_item_id, episodeIds)
    ))

  const wsMap = new Map(
    watchStateRows.map((ws) => [
      ws.media_item_id,
      {
        ws_position: ws.position_seconds,
        ws_duration: ws.duration_seconds,
        ws_completed: ws.completed ? 1 : 0,
        ws_updated_at: ws.updated_at,
      },
    ])
  )

  // Build PlayableEpisode list — only include episodes with a playable file
  const result: PlayableEpisode[] = []
  for (const ep of episodes) {
    if (!playableSet.has(ep.id)) continue

    const wsData = wsMap.get(ep.id)
    const row: EpisodeRow = {
      ...ep,
      ws_position: wsData?.ws_position ?? null,
      ws_duration: wsData?.ws_duration ?? null,
      ws_completed: wsData?.ws_completed ?? null,
      ws_updated_at: wsData?.ws_updated_at ?? null,
    }
    result.push(buildPlayableEpisode(row, show.id, show.title, true, baseUrl))
  }

  return result
}

// ─── getUpNextEpisode ─────────────────────────────────────────────────────────

/**
 * Returns the "up next" episode for a show:
 * 1. In-progress episode (watch_state exists, completed=false, position > 0)
 * 2. First uncompleted episode after the last completed episode
 * 3. If nothing completed, return the first playable episode
 * 4. All completed → return null
 */
export async function getUpNextEpisode(
  db: DrizzleDB,
  showId: string,
  userId: string,
  baseUrl?: string | null
): Promise<PlayableEpisode | null> {
  const ordered = await getOrderedEpisodes(db, showId, userId, baseUrl)
  if (ordered.length === 0) return null

  // 1. In-progress episode
  const inProgress = ordered.find(
    (ep) =>
      ep.watchState &&
      !ep.watchState.completed &&
      ep.watchState.position > 0
  )
  if (inProgress) return inProgress

  // 2. Find the last completed episode, then return the next one
  let lastCompletedIndex = -1
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].watchState?.completed) {
      lastCompletedIndex = i
      break
    }
  }

  if (lastCompletedIndex === -1) {
    // Nothing completed — return the first playable episode
    return ordered[0]
  }

  // Check if all completed
  const allCompleted = ordered.every((ep) => ep.watchState?.completed)
  if (allCompleted) return null

  // Return the first uncompleted episode after the last completed one
  for (let i = lastCompletedIndex + 1; i < ordered.length; i++) {
    if (!ordered[i].watchState?.completed) return ordered[i]
  }

  return null
}

// ─── getNextEpisode ───────────────────────────────────────────────────────────

/**
 * Returns the next episode after the given episodeId in show order.
 * Returns null if the episode is last in the show or has no playable file.
 */
export async function getNextEpisode(
  db: DrizzleDB,
  episodeId: string,
  userId: string,
  baseUrl?: string | null
): Promise<PlayableEpisode | null> {
  // Lookup episode to get its show
  const [episode] = await db
    .select({ id: mediaItems.id, parent_id: mediaItems.parent_id })
    .from(mediaItems)
    .where(and(eq(mediaItems.id, episodeId), eq(mediaItems.kind, 'episode')))
  if (!episode || !episode.parent_id) return null

  const [season] = await db
    .select({ id: mediaItems.id, parent_id: mediaItems.parent_id })
    .from(mediaItems)
    .where(and(eq(mediaItems.id, episode.parent_id), eq(mediaItems.kind, 'season')))
  if (!season || !season.parent_id) return null

  const showId = season.parent_id

  const ordered = await getOrderedEpisodes(db, showId, userId, baseUrl)
  const idx = ordered.findIndex((ep) => ep.id === episodeId)
  if (idx === -1 || idx === ordered.length - 1) return null

  return ordered[idx + 1]
}

// ─── getShowProgress ──────────────────────────────────────────────────────────

/**
 * Returns a summary of watch progress for the given show.
 */
export async function getShowProgress(
  db: DrizzleDB,
  showId: string,
  userId: string,
  baseUrl?: string | null
): Promise<ShowProgress> {
  const ordered = await getOrderedEpisodes(db, showId, userId, baseUrl)

  const totalEpisodes = ordered.length
  const completedEpisodes = ordered.filter((ep) => ep.watchState?.completed).length

  const inProgressEpisode =
    ordered.find(
      (ep) =>
        ep.watchState &&
        !ep.watchState.completed &&
        ep.watchState.position > 0
    ) ?? null

  const allCompleted = totalEpisodes > 0 && completedEpisodes === totalEpisodes
  const percentComplete =
    totalEpisodes === 0
      ? 0
      : Math.round((completedEpisodes / totalEpisodes) * 100)

  return {
    totalEpisodes,
    completedEpisodes,
    inProgressEpisode,
    percentComplete,
    allCompleted,
  }
}
