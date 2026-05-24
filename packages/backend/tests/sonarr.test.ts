/**
 * Sonarr provider tests — all mocked, no real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { testConnection, fetchSeries, fetchQualityProfiles } from '../src/services/integrations/providers/sonarr'

const BASE_URL = 'http://localhost:8989'
const API_KEY = 'sonarr-test-key-xyz'

describe('sonarr provider', () => {
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
        json: async () => ({ version: '4.0.9' }),
      })

      const result = await testConnection(BASE_URL, API_KEY)
      expect(result.ok).toBe(true)
      expect(result.version).toBe('4.0.9')
    })

    it('handles connection error gracefully', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('ECONNREFUSED')
      )

      const result = await testConnection(BASE_URL, API_KEY)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('ECONNREFUSED')
    })

    it('uses X-Api-Key header with GET only', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ version: '4.0.0' }),
      })
      vi.stubGlobal('fetch', mockFetch)

      await testConnection(BASE_URL, API_KEY)

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toContain('/api/v3/system/status')
      if (init?.method) {
        expect(init.method.toUpperCase()).toBe('GET')
      }
      expect((init?.headers as Record<string, string>)?.['X-Api-Key']).toBe(API_KEY)
    })
  })

  describe('fetchSeries', () => {
    it('parses series list with tvdbId, monitored, status', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 1,
            tvdbId: 81189,
            imdbId: 'tt0903747',
            title: 'Breaking Bad',
            year: 2008,
            monitored: true,
            status: 'ended',
            path: '/tv/Breaking Bad',
            qualityProfileId: 1,
          },
        ],
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 1, name: 'HD-1080p' }],
      })

      const series = await fetchSeries(BASE_URL, API_KEY)
      expect(series).toHaveLength(1)
      expect(series[0].externalId).toBe(1)
      expect(series[0].tvdbId).toBe(81189)
      expect(series[0].imdbId).toBe('tt0903747')
      expect(series[0].title).toBe('Breaking Bad')
      expect(series[0].year).toBe(2008)
      expect(series[0].monitored).toBe(true)
      expect(series[0].status).toBe('ended')
      expect(series[0].path).toBe('/tv/Breaking Bad')
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

      const series = await fetchSeries(BASE_URL, API_KEY)
      expect(series).toHaveLength(0)
    })

    it('handles 401 unauthorized', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      })

      await expect(fetchSeries(BASE_URL, API_KEY)).rejects.toThrow('Unauthorized')
    })

    it('series normalization: tvdbId, year, path mapped correctly', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 55,
            tvdbId: 153021,
            title: 'Chernobyl',
            year: 2019,
            monitored: false,
            status: 'ended',
            path: '/tv/Chernobyl',
            qualityProfileId: 3,
          },
        ],
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 3, name: 'Ultra-HD' }],
      })

      const [s] = await fetchSeries(BASE_URL, API_KEY)
      expect(s.externalId).toBe(55)
      expect(s.tvdbId).toBe(153021)
      expect(s.year).toBe(2019)
      expect(s.path).toBe('/tv/Chernobyl')
      expect(s.qualityProfileId).toBe(3)
    })

    it('quality profile name resolved from id', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { id: 7, tvdbId: 12345, title: 'Test Show', year: 2022, monitored: true, status: 'continuing', qualityProfileId: 8 },
        ],
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 8, name: 'WEB-DL 1080p' }],
      })

      const [s] = await fetchSeries(BASE_URL, API_KEY)
      expect(s.qualityProfileName).toBe('WEB-DL 1080p')
    })

    it('no write operations — only GET calls made', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      })

      await fetchSeries(BASE_URL, API_KEY)

      for (const call of mockFetch.mock.calls) {
        const [, init] = call
        const method = (init?.method ?? 'GET').toUpperCase()
        expect(method).toBe('GET')
      }
    })
  })
})
