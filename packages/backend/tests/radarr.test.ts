/**
 * Radarr provider tests — all mocked, no real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { testConnection, fetchMovies, fetchQualityProfiles } from '../src/services/integrations/providers/radarr'

const BASE_URL = 'http://localhost:7878'
const API_KEY = 'test-api-key-abc'

describe('radarr provider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('testConnection', () => {
    it('parses success response', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ version: '5.3.6' }),
      })

      const result = await testConnection(BASE_URL, API_KEY)
      expect(result.ok).toBe(true)
      expect(result.version).toBe('5.3.6')
      expect(result.error).toBeUndefined()
    })

    it('handles error/timeout gracefully', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Connection refused')
      )

      const result = await testConnection(BASE_URL, API_KEY)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Connection refused')
    })

    it('handles non-200 HTTP response', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })

      const result = await testConnection(BASE_URL, API_KEY)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('404')
    })

    it('uses X-Api-Key header (not POST/PUT/DELETE)', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ version: '5.0.0' }),
      })
      vi.stubGlobal('fetch', mockFetch)

      await testConnection(BASE_URL, API_KEY)

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toContain('/api/v3/system/status')
      // Should not have method set (defaults to GET) or use only GET
      if (init?.method) {
        expect(init.method.toUpperCase()).toBe('GET')
      }
      expect((init?.headers as Record<string, string>)?.['X-Api-Key']).toBe(API_KEY)
    })
  })

  describe('fetchMovies', () => {
    it('parses movie list with tmdbId, monitored, hasFile', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)

      // First call: quality profiles
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 1, name: 'HD-1080p' }],
      })
      // Second call: movies (fetch order: movies first, then qualityprofile)
      // Actually fetchMovies calls fetchQualityProfiles AFTER getting movies.
      // Let's check: fetchMovies does fetch movies, then fetchQualityProfiles.
      // So call order is: /api/v3/movie, then /api/v3/qualityprofile

      mockFetch.mockReset()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 42,
            tmdbId: 550,
            imdbId: 'tt0137523',
            title: 'Fight Club',
            year: 1999,
            monitored: true,
            hasFile: true,
            path: '/movies/Fight Club (1999)',
            qualityProfileId: 1,
          },
        ],
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 1, name: 'HD-1080p' }],
      })

      const movies = await fetchMovies(BASE_URL, API_KEY)
      expect(movies).toHaveLength(1)
      expect(movies[0].externalId).toBe(42)
      expect(movies[0].tmdbId).toBe(550)
      expect(movies[0].imdbId).toBe('tt0137523')
      expect(movies[0].title).toBe('Fight Club')
      expect(movies[0].year).toBe(1999)
      expect(movies[0].monitored).toBe(true)
      expect(movies[0].hasFile).toBe(true)
      expect(movies[0].path).toBe('/movies/Fight Club (1999)')
      expect(movies[0].qualityProfileName).toBe('HD-1080p')
    })

    it('handles empty list', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      })

      const movies = await fetchMovies(BASE_URL, API_KEY)
      expect(movies).toHaveLength(0)
    })

    it('handles 401 unauthorized', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      })

      await expect(fetchMovies(BASE_URL, API_KEY)).rejects.toThrow('Unauthorized')
    })

    it('quality profile name resolved from id', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { id: 10, tmdbId: 123, title: 'Some Movie', year: 2020, monitored: false, hasFile: false, qualityProfileId: 5 },
        ],
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { id: 5, name: '4K HDR' },
          { id: 6, name: 'SD' },
        ],
      })

      const movies = await fetchMovies(BASE_URL, API_KEY)
      expect(movies[0].qualityProfileName).toBe('4K HDR')
    })

    it('movie normalization: tmdbId, year, path, qualityProfile all mapped correctly', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 99,
            tmdbId: 27205,
            title: 'Inception',
            year: 2010,
            monitored: true,
            hasFile: false,
            path: '/movies/Inception (2010)',
            qualityProfileId: 2,
          },
        ],
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 2, name: 'Remux-1080p' }],
      })

      const [movie] = await fetchMovies(BASE_URL, API_KEY)
      expect(movie.externalId).toBe(99)
      expect(movie.tmdbId).toBe(27205)
      expect(movie.year).toBe(2010)
      expect(movie.path).toBe('/movies/Inception (2010)')
      expect(movie.qualityProfileId).toBe(2)
      expect(movie.qualityProfileName).toBe('Remux-1080p')
    })

    it('no write operations — only GET calls made', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      })

      await fetchMovies(BASE_URL, API_KEY)

      for (const call of mockFetch.mock.calls) {
        const [, init] = call
        const method = (init?.method ?? 'GET').toUpperCase()
        expect(method).toBe('GET')
      }
    })
  })
})
