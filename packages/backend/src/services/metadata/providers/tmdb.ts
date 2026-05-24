import type {
  MetadataProvider,
  MetadataCandidate,
  EnrichedMovieMetadata,
  EnrichedShowMetadata,
  EnrichedSeasonMetadata,
  EnrichedEpisodeMetadata,
  ArtworkCandidate,
  ProviderConfigurationStatus,
} from '../types'
import type { MediaItemKind } from '@helix/shared'

// ─── TMDB API response types ────────────────────────────────────────────────────

interface TmdbSearchResult {
  id: number
  title: string
  original_title: string
  overview: string
  release_date: string // "YYYY-MM-DD"
  poster_path: string | null
  backdrop_path: string | null
  vote_average: number
  popularity: number
}

interface TmdbSearchResponse {
  results: TmdbSearchResult[]
  total_results: number
  total_pages: number
  page: number
}

interface TmdbReleaseDateEntry {
  certification: string
  release_type: number
  release_date: string
}

interface TmdbReleaseDateCountry {
  iso_3166_1: string
  release_dates: TmdbReleaseDateEntry[]
}

interface TmdbReleaseDates {
  results: TmdbReleaseDateCountry[]
}

interface TmdbMovieDetails {
  id: number
  title: string
  original_title: string
  overview: string
  release_date: string
  runtime: number | null
  poster_path: string | null
  backdrop_path: string | null
  genres: Array<{ id: number; name: string }>
  releases?: TmdbReleaseDates
  release_dates?: TmdbReleaseDates
}

interface TmdbImageEntry {
  file_path: string
  width: number
  height: number
  iso_639_1: string | null
  vote_average: number
}

interface TmdbImagesResponse {
  id: number
  posters: TmdbImageEntry[]
  backdrops: TmdbImageEntry[]
}

// ─── TMDB TV API response types ─────────────────────────────────────────────────

interface TmdbTvSearchResult {
  id: number
  name: string
  original_name: string
  overview: string
  first_air_date: string // "YYYY-MM-DD"
  poster_path: string | null
  backdrop_path: string | null
  vote_average: number
  popularity: number
}

interface TmdbTvSearchResponse {
  results: TmdbTvSearchResult[]
  total_results: number
  total_pages: number
  page: number
}

interface TmdbContentRatingEntry {
  iso_3166_1: string
  rating: string
}

interface TmdbContentRatings {
  results: TmdbContentRatingEntry[]
}

interface TmdbTvDetails {
  id: number
  name: string
  original_name: string
  overview: string
  first_air_date: string
  poster_path: string | null
  backdrop_path: string | null
  genres: Array<{ id: number; name: string }>
  status: string
  content_ratings?: TmdbContentRatings
}

interface TmdbSeasonDetails {
  id: number
  name: string
  overview: string
  air_date: string | null
  poster_path: string | null
  season_number: number
}

interface TmdbEpisodeDetails {
  id: number
  name: string
  overview: string
  air_date: string | null
  runtime: number | null
  episode_number: number
  season_number: number
  still_path: string | null
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500'
const TMDB_IMAGE_ORIGINAL = 'https://image.tmdb.org/t/p/original'
const TMDB_IMAGE_STILL = 'https://image.tmdb.org/t/p/w300'

const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1000

// ─── Auth header builder ────────────────────────────────────────────────────────

function buildAuthHeaders(readToken: string | null): HeadersInit {
  if (readToken) {
    return { Authorization: `Bearer ${readToken}` }
  }
  return {}
}

function buildAuthQuery(apiKey: string | null, params: URLSearchParams): URLSearchParams {
  if (apiKey) {
    params.set('api_key', apiKey)
  }
  return params
}

// ─── Content rating extraction ──────────────────────────────────────────────────

function extractContentRating(releaseDates: TmdbReleaseDates | undefined): string | undefined {
  if (!releaseDates?.results) return undefined

  // Prefer US certification
  const us = releaseDates.results.find((c) => c.iso_3166_1 === 'US')
  if (us) {
    const cert = us.release_dates.find((r) => r.certification)?.certification
    if (cert) return cert
  }

  // Fallback to first available certification
  for (const country of releaseDates.results) {
    const cert = country.release_dates.find((r) => r.certification)?.certification
    if (cert) return cert
  }

  return undefined
}

// ─── TV content rating extraction ──────────────────────────────────────────────

function extractTvContentRating(contentRatings: TmdbContentRatings | undefined): string | undefined {
  if (!contentRatings?.results) return undefined

  // Prefer US rating
  const us = contentRatings.results.find((c) => c.iso_3166_1 === 'US')
  if (us?.rating) return us.rating

  // Fallback to first available
  const first = contentRatings.results.find((c) => c.rating)
  return first?.rating ?? undefined
}

// ─── Fetch with retry ───────────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = MAX_RETRIES
): Promise<Response> {
  const response = await fetch(url, init)

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get('Retry-After')
    const delay = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : RETRY_DELAY_MS

    if (retries > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
      return fetchWithRetry(url, init, retries - 1)
    }
  }

  return response
}

// ─── Year from release date ─────────────────────────────────────────────────────

function yearFromReleaseDate(releaseDate: string | undefined): number | undefined {
  if (!releaseDate) return undefined
  const year = parseInt(releaseDate.slice(0, 4), 10)
  return isNaN(year) ? undefined : year
}

// ─── TMDB Provider ──────────────────────────────────────────────────────────────

export class TmdbProvider implements MetadataProvider {
  readonly id = 'tmdb'
  readonly label = 'The Movie Database'
  readonly supportedKinds: MediaItemKind[] = ['movie', 'show', 'season', 'episode']

  private readonly readToken: string | null
  private readonly apiKey: string | null

  constructor(readToken: string | null = null, apiKey: string | null = null) {
    this.readToken = readToken
    this.apiKey = apiKey
  }

  get configurationStatus(): ProviderConfigurationStatus {
    return this.isConfigured() ? 'configured' : 'unconfigured'
  }

  isConfigured(): boolean {
    return !!(this.readToken || this.apiKey)
  }

  private buildUrl(path: string, params: URLSearchParams): string {
    if (!this.readToken && this.apiKey) {
      buildAuthQuery(this.apiKey, params)
    }
    const query = params.toString()
    return `${TMDB_BASE}${path}${query ? `?${query}` : ''}`
  }

  private buildHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (this.readToken) {
      return { ...headers, ...buildAuthHeaders(this.readToken) }
    }
    return headers
  }

  private async fetchJson<T>(path: string, params: URLSearchParams = new URLSearchParams()): Promise<T> {
    if (!this.isConfigured()) {
      throw new Error('TMDB provider is not configured — set TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY')
    }

    const url = this.buildUrl(path, params)
    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: this.buildHeaders(),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`TMDB API error ${response.status}: ${text}`)
    }

    return response.json() as Promise<T>
  }

  async searchMovies(title: string, year?: number): Promise<MetadataCandidate[]> {
    const params = new URLSearchParams({ query: title })
    if (year) params.set('year', String(year))

    const data = await this.fetchJson<TmdbSearchResponse>('/search/movie', params)

    return data.results.map((r) => ({
      providerId: this.id,
      externalId: String(r.id),
      title: r.title,
      originalTitle: r.original_title !== r.title ? r.original_title : undefined,
      year: yearFromReleaseDate(r.release_date),
      overview: r.overview || undefined,
      score: 0, // will be computed by scoring layer
      posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}${r.poster_path}` : undefined,
      backdropUrl: r.backdrop_path ? `${TMDB_IMAGE_ORIGINAL}${r.backdrop_path}` : undefined,
    }))
  }

  async getMovieDetails(tmdbId: string): Promise<EnrichedMovieMetadata | null> {
    const params = new URLSearchParams({ append_to_response: 'release_dates' })

    let data: TmdbMovieDetails
    try {
      data = await this.fetchJson<TmdbMovieDetails>(`/movie/${tmdbId}`, params)
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) return null
      throw e
    }

    // Prefer release_dates (v3 endpoint key) over releases
    const releaseDates = data.release_dates ?? data.releases
    const contentRating = extractContentRating(releaseDates)

    return {
      externalId: String(data.id),
      providerId: this.id,
      title: data.title,
      originalTitle: data.original_title !== data.title ? data.original_title : undefined,
      releaseDate: data.release_date || undefined,
      overview: data.overview || undefined,
      runtimeMinutes: data.runtime ?? undefined,
      contentRating,
      posterUrl: data.poster_path ? `${TMDB_IMAGE_BASE}${data.poster_path}` : undefined,
      backdropUrl: data.backdrop_path ? `${TMDB_IMAGE_ORIGINAL}${data.backdrop_path}` : undefined,
      genres: data.genres?.map((g) => g.name) ?? [],
    }
  }

  async getArtwork(tmdbId: string): Promise<ArtworkCandidate[]> {
    const data = await this.fetchJson<TmdbImagesResponse>(`/movie/${tmdbId}/images`)

    const results: ArtworkCandidate[] = []

    for (const img of data.posters ?? []) {
      results.push({
        kind: 'poster',
        url: `${TMDB_IMAGE_BASE}${img.file_path}`,
        width: img.width,
        height: img.height,
        language: img.iso_639_1 ?? undefined,
      })
    }

    for (const img of data.backdrops ?? []) {
      results.push({
        kind: 'backdrop',
        url: `${TMDB_IMAGE_ORIGINAL}${img.file_path}`,
        width: img.width,
        height: img.height,
        language: img.iso_639_1 ?? undefined,
      })
    }

    return results
  }

  // ─── TV methods ─────────────────────────────────────────────────────────────

  async searchShows(title: string, year?: number): Promise<MetadataCandidate[]> {
    const params = new URLSearchParams({ query: title })
    if (year) params.set('first_air_date_year', String(year))

    const data = await this.fetchJson<TmdbTvSearchResponse>('/search/tv', params)

    return data.results.map((r) => ({
      providerId: this.id,
      externalId: String(r.id),
      title: r.name,
      originalTitle: r.original_name !== r.name ? r.original_name : undefined,
      year: yearFromReleaseDate(r.first_air_date),
      overview: r.overview || undefined,
      score: 0, // set by scoring layer
      posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}${r.poster_path}` : undefined,
      backdropUrl: r.backdrop_path ? `${TMDB_IMAGE_ORIGINAL}${r.backdrop_path}` : undefined,
    }))
  }

  async getShowDetails(externalShowId: string): Promise<EnrichedShowMetadata | null> {
    const params = new URLSearchParams({ append_to_response: 'content_ratings' })

    let data: TmdbTvDetails
    try {
      data = await this.fetchJson<TmdbTvDetails>(`/tv/${externalShowId}`, params)
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) return null
      throw e
    }

    // Extract content rating — prefer US, fallback to first available
    const contentRating = extractTvContentRating(data.content_ratings)

    return {
      externalId: String(data.id),
      providerId: this.id,
      title: data.name,
      originalTitle: data.original_name !== data.name ? data.original_name : undefined,
      firstAirDate: data.first_air_date || undefined,
      overview: data.overview || undefined,
      contentRating,
      posterUrl: data.poster_path ? `${TMDB_IMAGE_BASE}${data.poster_path}` : undefined,
      backdropUrl: data.backdrop_path ? `${TMDB_IMAGE_ORIGINAL}${data.backdrop_path}` : undefined,
      genres: data.genres?.map((g) => g.name) ?? [],
      status: data.status || undefined,
    }
  }

  async getSeasonDetails(externalShowId: string, seasonNumber: number): Promise<EnrichedSeasonMetadata | null> {
    let data: TmdbSeasonDetails
    try {
      data = await this.fetchJson<TmdbSeasonDetails>(`/tv/${externalShowId}/season/${seasonNumber}`)
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) return null
      throw e
    }

    return {
      externalShowId,
      seasonNumber: data.season_number,
      title: data.name || undefined,
      overview: data.overview || undefined,
      airDate: data.air_date || undefined,
      posterUrl: data.poster_path ? `${TMDB_IMAGE_BASE}${data.poster_path}` : undefined,
    }
  }

  async getEpisodeDetails(
    externalShowId: string,
    seasonNumber: number,
    episodeNumber: number,
  ): Promise<EnrichedEpisodeMetadata | null> {
    let data: TmdbEpisodeDetails
    try {
      data = await this.fetchJson<TmdbEpisodeDetails>(
        `/tv/${externalShowId}/season/${seasonNumber}/episode/${episodeNumber}`,
      )
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) return null
      throw e
    }

    return {
      externalShowId,
      seasonNumber: data.season_number,
      episodeNumber: data.episode_number,
      title: data.name || undefined,
      overview: data.overview || undefined,
      airDate: data.air_date || undefined,
      runtimeMinutes: data.runtime ?? undefined,
      stillUrl: data.still_path ? `${TMDB_IMAGE_STILL}${data.still_path}` : undefined,
    }
  }

  async getShowArtwork(externalShowId: string): Promise<ArtworkCandidate[]> {
    const data = await this.fetchJson<TmdbImagesResponse>(`/tv/${externalShowId}/images`)

    const results: ArtworkCandidate[] = []

    for (const img of data.posters ?? []) {
      results.push({
        kind: 'poster',
        url: `${TMDB_IMAGE_BASE}${img.file_path}`,
        width: img.width,
        height: img.height,
        language: img.iso_639_1 ?? undefined,
      })
    }

    for (const img of data.backdrops ?? []) {
      results.push({
        kind: 'backdrop',
        url: `${TMDB_IMAGE_ORIGINAL}${img.file_path}`,
        width: img.width,
        height: img.height,
        language: img.iso_639_1 ?? undefined,
      })
    }

    return results
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────────

export function createTmdbProvider(
  readToken: string | null,
  apiKey: string | null
): TmdbProvider {
  return new TmdbProvider(readToken, apiKey)
}
