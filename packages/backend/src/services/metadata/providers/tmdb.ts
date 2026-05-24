import type {
  MetadataProvider,
  MetadataCandidate,
  EnrichedMovieMetadata,
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

// ─── Constants ──────────────────────────────────────────────────────────────────

const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500'
const TMDB_IMAGE_ORIGINAL = 'https://image.tmdb.org/t/p/original'

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
  readonly supportedKinds: MediaItemKind[] = ['movie']

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
}

// ─── Factory ────────────────────────────────────────────────────────────────────

export function createTmdbProvider(
  readToken: string | null,
  apiKey: string | null
): TmdbProvider {
  return new TmdbProvider(readToken, apiKey)
}
