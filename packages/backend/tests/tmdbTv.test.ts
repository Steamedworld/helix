import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TmdbProvider } from '../src/services/metadata/providers/tmdb'

// ─── Mock fetch helper ──────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => key.toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

// ─── Fixture responses ──────────────────────────────────────────────────────────

const TV_SEARCH_RESPONSE = {
  results: [
    {
      id: 1396,
      name: 'Breaking Bad',
      original_name: 'Breaking Bad',
      overview: 'A chemistry teacher diagnosed with inoperable lung cancer.',
      first_air_date: '2008-01-20',
      poster_path: '/ggFHVNu6YYI5L9pCfOacjizRGt.jpg',
      backdrop_path: '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
      vote_average: 8.9,
      popularity: 300,
    },
    {
      id: 99999,
      name: 'Breaking Bad Fan Series',
      original_name: 'Breaking Bad Fan Series',
      overview: 'A fan-made spin-off.',
      first_air_date: '2012-01-01',
      poster_path: null,
      backdrop_path: null,
      vote_average: 5.0,
      popularity: 10,
    },
  ],
  total_results: 2,
  total_pages: 1,
  page: 1,
}

const SHOW_DETAILS_RESPONSE = {
  id: 1396,
  name: 'Breaking Bad',
  original_name: 'Breaking Bad',
  overview: 'A chemistry teacher diagnosed with inoperable lung cancer.',
  first_air_date: '2008-01-20',
  poster_path: '/ggFHVNu6YYI5L9pCfOacjizRGt.jpg',
  backdrop_path: '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
  genres: [{ id: 18, name: 'Drama' }, { id: 80, name: 'Crime' }],
  status: 'Ended',
  content_ratings: {
    results: [
      { iso_3166_1: 'US', rating: 'TV-MA' },
      { iso_3166_1: 'GB', rating: '18' },
    ],
  },
}

const SEASON_DETAILS_RESPONSE = {
  id: 3572,
  name: 'Season 1',
  overview: 'Walter White, a chemistry teacher, starts making meth.',
  air_date: '2008-01-20',
  poster_path: '/season1poster.jpg',
  season_number: 1,
}

const EPISODE_DETAILS_RESPONSE = {
  id: 62085,
  name: 'Pilot',
  overview: 'Walter White is diagnosed with lung cancer.',
  air_date: '2008-01-20',
  runtime: 58,
  episode_number: 1,
  season_number: 1,
  still_path: '/still1.jpg',
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('TmdbProvider — TV methods', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // ─── supportedKinds ──────────────────────────────────────────────────────────

  it('supportedKinds includes show, season, and episode', () => {
    const provider = new TmdbProvider('token', null)
    expect(provider.supportedKinds).toContain('movie')
    expect(provider.supportedKinds).toContain('show')
    expect(provider.supportedKinds).toContain('season')
    expect(provider.supportedKinds).toContain('episode')
  })

  // ─── searchShows ─────────────────────────────────────────────────────────────

  it('searchShows parses mocked /search/tv response correctly', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(TV_SEARCH_RESPONSE) as any

    const results = await provider.searchShows!('Breaking Bad', 2008)

    expect(results).toHaveLength(2)
    const first = results[0]
    expect(first.providerId).toBe('tmdb')
    expect(first.externalId).toBe('1396')
    expect(first.title).toBe('Breaking Bad')
    expect(first.year).toBe(2008)
    expect(first.overview).toBe('A chemistry teacher diagnosed with inoperable lung cancer.')
    expect(first.posterUrl).toContain('/ggFHVNu6YYI5L9pCfOacjizRGt.jpg')
    expect(first.backdropUrl).toContain('/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg')
    expect(first.score).toBe(0) // set by scoring layer
  })

  it('searchShows uses first_air_date_year param when year provided', async () => {
    const provider = new TmdbProvider('token', null)
    const fetchMock = mockFetch(TV_SEARCH_RESPONSE)
    global.fetch = fetchMock as any

    await provider.searchShows!('Breaking Bad', 2008)

    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('/search/tv')
    expect(url).toContain('first_air_date_year=2008')
  })

  it('searchShows handles null poster/backdrop gracefully', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(TV_SEARCH_RESPONSE) as any

    const results = await provider.searchShows!('Breaking Bad')
    const second = results.find((r) => r.externalId === '99999')
    expect(second?.posterUrl).toBeUndefined()
    expect(second?.backdropUrl).toBeUndefined()
  })

  it('searchShows throws when not configured', async () => {
    const provider = new TmdbProvider(null, null)
    await expect(provider.searchShows!('Breaking Bad')).rejects.toThrow(/not configured/i)
  })

  it('searchShows returns empty array when no results', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch({ results: [], total_results: 0, total_pages: 0, page: 1 }) as any

    const results = await provider.searchShows!('Nonexistent Show')
    expect(results).toHaveLength(0)
  })

  // ─── getShowDetails ──────────────────────────────────────────────────────────

  it('getShowDetails parses mocked /tv/:id response correctly', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(SHOW_DETAILS_RESPONSE) as any

    const details = await provider.getShowDetails!('1396')

    expect(details).not.toBeNull()
    expect(details!.externalId).toBe('1396')
    expect(details!.providerId).toBe('tmdb')
    expect(details!.title).toBe('Breaking Bad')
    expect(details!.firstAirDate).toBe('2008-01-20')
    expect(details!.overview).toBe('A chemistry teacher diagnosed with inoperable lung cancer.')
    expect(details!.genres).toContain('Drama')
    expect(details!.genres).toContain('Crime')
    expect(details!.status).toBe('Ended')
    expect(details!.posterUrl).toContain('/ggFHVNu6YYI5L9pCfOacjizRGt.jpg')
    expect(details!.backdropUrl).toContain('/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg')
  })

  it('getShowDetails extracts US content rating', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(SHOW_DETAILS_RESPONSE) as any

    const details = await provider.getShowDetails!('1396')
    expect(details!.contentRating).toBe('TV-MA')
  })

  it('getShowDetails falls back to first rating when no US entry', async () => {
    const noUs = {
      ...SHOW_DETAILS_RESPONSE,
      content_ratings: {
        results: [{ iso_3166_1: 'GB', rating: '18' }],
      },
    }
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(noUs) as any

    const details = await provider.getShowDetails!('1396')
    expect(details!.contentRating).toBe('18')
  })

  it('getShowDetails returns null on 404', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: () => Promise.resolve('{"status_message":"Not found"}'),
    }) as any

    const result = await provider.getShowDetails!('nonexistent')
    expect(result).toBeNull()
  })

  it('getShowDetails throws when not configured', async () => {
    const provider = new TmdbProvider(null, null)
    await expect(provider.getShowDetails!('1396')).rejects.toThrow(/not configured/i)
  })

  // ─── getSeasonDetails ────────────────────────────────────────────────────────

  it('getSeasonDetails parses mocked /tv/:id/season/:n response correctly', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(SEASON_DETAILS_RESPONSE) as any

    const details = await provider.getSeasonDetails!('1396', 1)

    expect(details).not.toBeNull()
    expect(details!.externalShowId).toBe('1396')
    expect(details!.seasonNumber).toBe(1)
    expect(details!.title).toBe('Season 1')
    expect(details!.overview).toBe('Walter White, a chemistry teacher, starts making meth.')
    expect(details!.airDate).toBe('2008-01-20')
    expect(details!.posterUrl).toContain('/season1poster.jpg')
  })

  it('getSeasonDetails fetches correct URL', async () => {
    const provider = new TmdbProvider('token', null)
    const fetchMock = mockFetch(SEASON_DETAILS_RESPONSE)
    global.fetch = fetchMock as any

    await provider.getSeasonDetails!('1396', 2)

    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('/tv/1396/season/2')
  })

  it('getSeasonDetails returns null on 404', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: () => Promise.resolve('{"status_message":"Not found"}'),
    }) as any

    const result = await provider.getSeasonDetails!('1396', 99)
    expect(result).toBeNull()
  })

  it('getSeasonDetails handles null poster_path', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch({ ...SEASON_DETAILS_RESPONSE, poster_path: null }) as any

    const details = await provider.getSeasonDetails!('1396', 1)
    expect(details!.posterUrl).toBeUndefined()
  })

  it('getSeasonDetails throws when not configured', async () => {
    const provider = new TmdbProvider(null, null)
    await expect(provider.getSeasonDetails!('1396', 1)).rejects.toThrow(/not configured/i)
  })

  // ─── getEpisodeDetails ───────────────────────────────────────────────────────

  it('getEpisodeDetails parses mocked /tv/:id/season/:n/episode/:m response correctly', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch(EPISODE_DETAILS_RESPONSE) as any

    const details = await provider.getEpisodeDetails!('1396', 1, 1)

    expect(details).not.toBeNull()
    expect(details!.externalShowId).toBe('1396')
    expect(details!.seasonNumber).toBe(1)
    expect(details!.episodeNumber).toBe(1)
    expect(details!.title).toBe('Pilot')
    expect(details!.overview).toBe('Walter White is diagnosed with lung cancer.')
    expect(details!.airDate).toBe('2008-01-20')
    expect(details!.runtimeMinutes).toBe(58)
    expect(details!.stillUrl).toContain('/still1.jpg')
    expect(details!.stillUrl).toContain('w300')
  })

  it('getEpisodeDetails fetches correct URL', async () => {
    const provider = new TmdbProvider('token', null)
    const fetchMock = mockFetch(EPISODE_DETAILS_RESPONSE)
    global.fetch = fetchMock as any

    await provider.getEpisodeDetails!('1396', 1, 3)

    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('/tv/1396/season/1/episode/3')
  })

  it('getEpisodeDetails returns null on 404', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: () => Promise.resolve('{"status_message":"Not found"}'),
    }) as any

    const result = await provider.getEpisodeDetails!('1396', 1, 999)
    expect(result).toBeNull()
  })

  it('getEpisodeDetails handles null still_path', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch({ ...EPISODE_DETAILS_RESPONSE, still_path: null }) as any

    const details = await provider.getEpisodeDetails!('1396', 1, 1)
    expect(details!.stillUrl).toBeUndefined()
  })

  it('getEpisodeDetails handles null runtime', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch({ ...EPISODE_DETAILS_RESPONSE, runtime: null }) as any

    const details = await provider.getEpisodeDetails!('1396', 1, 1)
    expect(details!.runtimeMinutes).toBeUndefined()
  })

  it('getEpisodeDetails throws when not configured', async () => {
    const provider = new TmdbProvider(null, null)
    await expect(provider.getEpisodeDetails!('1396', 1, 1)).rejects.toThrow(/not configured/i)
  })

  // ─── getShowArtwork ──────────────────────────────────────────────────────────

  it('getShowArtwork fetches /tv/:id/images and returns poster+backdrop candidates', async () => {
    const provider = new TmdbProvider('token', null)
    global.fetch = mockFetch({
      id: 1396,
      posters: [
        { file_path: '/poster1.jpg', width: 500, height: 750, iso_639_1: 'en', vote_average: 8 },
      ],
      backdrops: [
        { file_path: '/backdrop1.jpg', width: 1280, height: 720, iso_639_1: null, vote_average: 7 },
      ],
    }) as any

    const fetchMock = mockFetch({
      id: 1396,
      posters: [{ file_path: '/poster1.jpg', width: 500, height: 750, iso_639_1: 'en', vote_average: 8 }],
      backdrops: [{ file_path: '/backdrop1.jpg', width: 1280, height: 720, iso_639_1: null, vote_average: 7 }],
    })
    global.fetch = fetchMock as any

    const artwork = await provider.getShowArtwork!('1396')

    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('/tv/1396/images')

    const poster = artwork.find((a) => a.kind === 'poster')
    const backdrop = artwork.find((a) => a.kind === 'backdrop')

    expect(poster).toBeDefined()
    expect(poster!.url).toContain('/poster1.jpg')
    expect(backdrop).toBeDefined()
    expect(backdrop!.url).toContain('/backdrop1.jpg')
  })

  it('getShowArtwork throws when not configured', async () => {
    const provider = new TmdbProvider(null, null)
    await expect(provider.getShowArtwork!('1396')).rejects.toThrow(/not configured/i)
  })
})
