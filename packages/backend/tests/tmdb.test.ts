import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TmdbProvider } from '../src/services/metadata/providers/tmdb'

// ─── Mock fetch globally ────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const responseHeaders = new Map(Object.entries({ 'Content-Type': 'application/json', ...headers }))
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => responseHeaders.get(key) ?? null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

const SEARCH_RESPONSE = {
  results: [
    {
      id: 12345,
      title: 'The Matrix',
      original_title: 'The Matrix',
      overview: 'A hacker discovers reality is a simulation.',
      release_date: '1999-03-31',
      poster_path: '/poster.jpg',
      backdrop_path: '/backdrop.jpg',
      vote_average: 8.7,
      popularity: 100,
    },
    {
      id: 99999,
      title: 'Matrix Reloaded',
      original_title: 'The Matrix Reloaded',
      overview: 'Sequel.',
      release_date: '2003-05-15',
      poster_path: null,
      backdrop_path: null,
      vote_average: 7.2,
      popularity: 50,
    },
  ],
  total_results: 2,
  total_pages: 1,
  page: 1,
}

const MOVIE_DETAILS_RESPONSE = {
  id: 12345,
  title: 'The Matrix',
  original_title: 'The Matrix',
  overview: 'A hacker discovers reality is a simulation.',
  release_date: '1999-03-31',
  runtime: 136,
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  genres: [{ id: 878, name: 'Science Fiction' }, { id: 28, name: 'Action' }],
  release_dates: {
    results: [
      {
        iso_3166_1: 'US',
        release_dates: [
          { certification: 'R', release_type: 3, release_date: '1999-03-31' },
        ],
      },
    ],
  },
}

const RATE_LIMIT_RESPONSE = {
  status_message: 'Your request count is over the allowed limit.',
  status_code: 25,
}

describe('TmdbProvider', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // ─── isConfigured ─────────────────────────────────────────────────────────────

  it('isConfigured returns false when no credentials', () => {
    const provider = new TmdbProvider(null, null)
    expect(provider.isConfigured()).toBe(false)
    expect(provider.configurationStatus).toBe('unconfigured')
  })

  it('isConfigured returns true when TMDB_API_KEY is set', () => {
    const provider = new TmdbProvider(null, 'test-api-key')
    expect(provider.isConfigured()).toBe(true)
    expect(provider.configurationStatus).toBe('configured')
  })

  it('isConfigured returns true when TMDB_READ_ACCESS_TOKEN is set', () => {
    const provider = new TmdbProvider('test-read-token', null)
    expect(provider.isConfigured()).toBe(true)
    expect(provider.configurationStatus).toBe('configured')
  })

  // ─── searchMovies ─────────────────────────────────────────────────────────────

  it('searchMovies parses mocked response correctly', async () => {
    const provider = new TmdbProvider('test-token', null)
    global.fetch = mockFetch(SEARCH_RESPONSE) as any

    const results = await provider.searchMovies('The Matrix', 1999)

    expect(results).toHaveLength(2)
    const first = results[0]
    expect(first.providerId).toBe('tmdb')
    expect(first.externalId).toBe('12345')
    expect(first.title).toBe('The Matrix')
    expect(first.year).toBe(1999)
    expect(first.overview).toBe('A hacker discovers reality is a simulation.')
    expect(first.posterUrl).toContain('/poster.jpg')
    expect(first.backdropUrl).toContain('/backdrop.jpg')
    expect(first.score).toBe(0) // score is set by scoring layer, not provider
  })

  it('searchMovies builds correct Authorization header with read token', async () => {
    const provider = new TmdbProvider('my-read-token', null)
    const fetchMock = mockFetch(SEARCH_RESPONSE)
    global.fetch = fetchMock as any

    await provider.searchMovies('The Matrix')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/search/movie')
    expect(url).toContain('query=The+Matrix')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer my-read-token' })
  })

  it('searchMovies includes year param when provided', async () => {
    const provider = new TmdbProvider('token', null)
    const fetchMock = mockFetch(SEARCH_RESPONSE)
    global.fetch = fetchMock as any

    await provider.searchMovies('The Matrix', 1999)

    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('year=1999')
  })

  it('searchMovies uses api_key query param when only apiKey provided', async () => {
    const provider = new TmdbProvider(null, 'my-api-key')
    const fetchMock = mockFetch(SEARCH_RESPONSE)
    global.fetch = fetchMock as any

    await provider.searchMovies('The Matrix')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('api_key=my-api-key')
    // No Authorization header
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  it('searchMovies returns empty array when results is empty', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch({ results: [], total_results: 0, total_pages: 0, page: 1 }) as any

    const results = await provider.searchMovies('Nonexistent Movie')
    expect(results).toHaveLength(0)
  })

  it('searchMovies handles null poster_path gracefully', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(SEARCH_RESPONSE) as any

    const results = await provider.searchMovies('Matrix')
    const second = results.find((r) => r.externalId === '99999')
    expect(second?.posterUrl).toBeUndefined()
    expect(second?.backdropUrl).toBeUndefined()
  })

  it('searchMovies throws when not configured', async () => {
    const provider = new TmdbProvider(null, null)
    await expect(provider.searchMovies('The Matrix')).rejects.toThrow(/not configured/i)
  })

  // ─── getMovieDetails ──────────────────────────────────────────────────────────

  it('getMovieDetails parses mocked response correctly', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(MOVIE_DETAILS_RESPONSE) as any

    const details = await provider.getMovieDetails('12345')

    expect(details).not.toBeNull()
    expect(details!.externalId).toBe('12345')
    expect(details!.providerId).toBe('tmdb')
    expect(details!.title).toBe('The Matrix')
    expect(details!.releaseDate).toBe('1999-03-31')
    expect(details!.runtimeMinutes).toBe(136)
    expect(details!.overview).toBe('A hacker discovers reality is a simulation.')
    expect(details!.contentRating).toBe('R')
    expect(details!.posterUrl).toContain('/poster.jpg')
    expect(details!.genres).toContain('Science Fiction')
    expect(details!.genres).toContain('Action')
  })

  it('getMovieDetails returns null on 404', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: () => Promise.resolve('{"status_message":"Not found"}'),
    }) as any

    // 404 throws an error containing '404' which getMovieDetails catches
    const result = await provider.getMovieDetails('nonexistent')
    expect(result).toBeNull()
  })

  it('getMovieDetails extracts US content rating from release_dates', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(MOVIE_DETAILS_RESPONSE) as any

    const details = await provider.getMovieDetails('12345')
    expect(details?.contentRating).toBe('R')
  })

  it('getMovieDetails falls back to first available certification when no US entry', async () => {
    const noUsResponse = {
      ...MOVIE_DETAILS_RESPONSE,
      release_dates: {
        results: [
          {
            iso_3166_1: 'GB',
            release_dates: [{ certification: '15', release_type: 3, release_date: '1999-06-11' }],
          },
        ],
      },
    }
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(noUsResponse) as any

    const details = await provider.getMovieDetails('12345')
    expect(details?.contentRating).toBe('15')
  })

  it('getMovieDetails returns undefined contentRating when no certifications exist', async () => {
    const noCerts = {
      ...MOVIE_DETAILS_RESPONSE,
      release_dates: {
        results: [
          {
            iso_3166_1: 'US',
            release_dates: [{ certification: '', release_type: 3, release_date: '1999-03-31' }],
          },
        ],
      },
    }
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(noCerts) as any

    const details = await provider.getMovieDetails('12345')
    expect(details?.contentRating).toBeUndefined()
  })

  // ─── Rate limiting ────────────────────────────────────────────────────────────

  it('rate limit 429 response causes retry and eventually returns result', async () => {
    const provider = new TmdbProvider('token', null)
    let callCount = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          headers: {
            get: (key: string) => key.toLowerCase() === 'retry-after' ? '0' : null,
          },
          json: () => Promise.resolve(RATE_LIMIT_RESPONSE),
          text: () => Promise.resolve(JSON.stringify(RATE_LIMIT_RESPONSE)),
        }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve(SEARCH_RESPONSE),
        text: () => Promise.resolve(JSON.stringify(SEARCH_RESPONSE)),
      }
    }) as any

    const results = await provider.searchMovies('The Matrix')
    expect(results.length).toBeGreaterThan(0)
    expect(callCount).toBe(2)
  }, 10000)

  it('rate limit exhausted: throws after max retries', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: {
        get: (key: string) => key.toLowerCase() === 'retry-after' ? '0' : null,
      },
      json: () => Promise.resolve(RATE_LIMIT_RESPONSE),
      text: () => Promise.resolve(JSON.stringify(RATE_LIMIT_RESPONSE)),
    }) as any

    await expect(provider.searchMovies('The Matrix')).rejects.toThrow()
  }, 10000)
})
