import { eq, and } from 'drizzle-orm'
import { mediaItems } from '../../db/schema'
import type { DrizzleDB } from '../../db/client'
import type { ArrMovieSummary, ArrSeriesSummary, MappingResult } from './types'

/**
 * Normalize a title for fuzzy matching:
 * - lowercase
 * - remove punctuation/articles
 * - collapse whitespace
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Map Radarr movies to Helix media_items (kind='movie').
 * Strategy:
 * 1. TMDB ID match
 * 2. Normalized title + year match (year within ±1)
 */
export async function mapRadarrMovies(
  db: DrizzleDB,
  movies: ArrMovieSummary[]
): Promise<MappingResult[]> {
  // Load all Helix movie items once
  const helixMovies = await db
    .select({
      id: mediaItems.id,
      title: mediaItems.title,
      year: mediaItems.year,
      external_tmdb_id: mediaItems.external_tmdb_id,
    })
    .from(mediaItems)
    .where(eq(mediaItems.kind, 'movie'))

  const results: MappingResult[] = []

  for (const movie of movies) {
    let matchedId: string | null = null

    // 1. TMDB id match
    if (movie.tmdbId !== undefined) {
      const tmdbStr = String(movie.tmdbId)
      const match = helixMovies.find((h) => h.external_tmdb_id === tmdbStr)
      if (match) {
        matchedId = match.id
      }
    }

    // 2. Title + year fallback
    if (!matchedId) {
      const normArrTitle = normalizeTitle(movie.title)
      const arrYear = movie.year
      const match = helixMovies.find((h) => {
        if (normalizeTitle(h.title) !== normArrTitle) return false
        if (arrYear === undefined || h.year === null || h.year === undefined) {
          // If either side has no year, match on title alone
          return true
        }
        return Math.abs(h.year - arrYear) <= 1
      })
      if (match) {
        matchedId = match.id
      }
    }

    if (matchedId) {
      results.push({ helixItemId: matchedId, arrMovie: movie })
    }
  }

  return results
}

/**
 * Map Sonarr series to Helix media_items (kind='show').
 * Strategy:
 * 1. TVDB id match (if Helix has external_tvdb_id)
 * 2. TMDB id match (if Sonarr series has tmdbId)
 * 3. Normalized title + first air year match
 */
export async function mapSonarrSeries(
  db: DrizzleDB,
  series: ArrSeriesSummary[]
): Promise<MappingResult[]> {
  const helixShows = await db
    .select({
      id: mediaItems.id,
      title: mediaItems.title,
      year: mediaItems.year,
      external_tmdb_id: mediaItems.external_tmdb_id,
      external_tvdb_id: mediaItems.external_tvdb_id,
    })
    .from(mediaItems)
    .where(eq(mediaItems.kind, 'show'))

  const results: MappingResult[] = []

  for (const s of series) {
    let matchedId: string | null = null

    // 1. TVDB id match
    if (s.tvdbId !== undefined) {
      const tvdbStr = String(s.tvdbId)
      const match = helixShows.find((h) => h.external_tvdb_id === tvdbStr)
      if (match) {
        matchedId = match.id
      }
    }

    // 2. TMDB id match
    if (!matchedId && s.tmdbId !== undefined) {
      const tmdbStr = String(s.tmdbId)
      const match = helixShows.find((h) => h.external_tmdb_id === tmdbStr)
      if (match) {
        matchedId = match.id
      }
    }

    // 3. Title + year fallback
    if (!matchedId) {
      const normArrTitle = normalizeTitle(s.title)
      const arrYear = s.year
      const match = helixShows.find((h) => {
        if (normalizeTitle(h.title) !== normArrTitle) return false
        if (arrYear === undefined || h.year === null || h.year === undefined) {
          return true
        }
        return Math.abs(h.year - arrYear) <= 1
      })
      if (match) {
        matchedId = match.id
      }
    }

    if (matchedId) {
      results.push({ helixItemId: matchedId, arrSeries: s })
    }
  }

  return results
}
