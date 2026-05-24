import type { IntegrationTestResult, ArrSeriesSummary } from '../types'

function makeHeaders(apiKey: string): Record<string, string> {
  return {
    'X-Api-Key': apiKey,
    'Accept': 'application/json',
  }
}

/**
 * GET {baseUrl}/api/v3/system/status — test connection
 */
export async function testConnection(baseUrl: string, apiKey: string): Promise<IntegrationTestResult> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/v3/system/status`
    const res = await fetch(url, { headers: makeHeaders(apiKey), signal: AbortSignal.timeout(10000) })
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` }
    }
    const data = await res.json() as { version?: string }
    return { ok: true, version: data.version }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

/**
 * GET {baseUrl}/api/v3/qualityprofile — returns id→name map
 */
export async function fetchQualityProfiles(baseUrl: string, apiKey: string): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/v3/qualityprofile`
    const res = await fetch(url, { headers: makeHeaders(apiKey), signal: AbortSignal.timeout(10000) })
    if (!res.ok) return map
    const data = await res.json() as Array<{ id: number; name: string }>
    for (const profile of data) {
      map.set(profile.id, profile.name)
    }
  } catch {
    // Return empty map on error
  }
  return map
}

interface SonarrSeriesRaw {
  id: number
  tvdbId?: number
  tmdbId?: number
  imdbId?: string
  title?: string
  year?: number
  monitored?: boolean
  status?: string
  path?: string
  qualityProfileId?: number
}

/**
 * GET {baseUrl}/api/v3/series — fetch all series
 */
export async function fetchSeries(baseUrl: string, apiKey: string): Promise<ArrSeriesSummary[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v3/series`
  const res = await fetch(url, { headers: makeHeaders(apiKey), signal: AbortSignal.timeout(30000) })

  if (res.status === 401) {
    throw new Error('Unauthorized: check your Sonarr API key')
  }
  if (!res.ok) {
    throw new Error(`Sonarr API error: HTTP ${res.status}: ${res.statusText}`)
  }

  const data = await res.json() as SonarrSeriesRaw[]
  const profiles = await fetchQualityProfiles(baseUrl, apiKey)

  return data.map((series): ArrSeriesSummary => ({
    externalId: series.id,
    tvdbId: series.tvdbId,
    tmdbId: series.tmdbId,
    imdbId: series.imdbId,
    title: series.title ?? '',
    year: series.year,
    monitored: series.monitored ?? false,
    status: series.status,
    path: series.path,
    qualityProfileId: series.qualityProfileId,
    qualityProfileName: series.qualityProfileId !== undefined
      ? profiles.get(series.qualityProfileId)
      : undefined,
  }))
}
