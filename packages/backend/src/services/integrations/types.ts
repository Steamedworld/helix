export type IntegrationKind = 'radarr' | 'sonarr' | 'lidarr' | 'prowlarr' | 'other'
export type IntegrationStatus = 'unknown' | 'online' | 'offline' | 'error'

export interface IntegrationProvider {
  kind: IntegrationKind
  label: string
  testConnection(baseUrl: string, apiKey: string): Promise<IntegrationTestResult>
}

export interface IntegrationTestResult {
  ok: boolean
  version?: string
  error?: string
}

export interface ArrMovieSummary {
  externalId: number
  tmdbId?: number
  imdbId?: string
  title: string
  year?: number
  monitored: boolean
  hasFile: boolean
  path?: string
  qualityProfileId?: number
  qualityProfileName?: string
}

export interface ArrSeriesSummary {
  externalId: number
  tvdbId?: number
  tmdbId?: number
  imdbId?: string
  title: string
  year?: number
  monitored: boolean
  status?: string
  path?: string
  qualityProfileId?: number
  qualityProfileName?: string
}

export interface ExternalMediaLink {
  id: string
  mediaItemId: string
  integrationId: string
  externalKind: 'radarr_movie' | 'sonarr_series' | 'sonarr_episode'
  externalId: string
  externalGuid?: string
  externalTitle?: string
  monitored?: boolean
  qualityProfile?: string
  rootPath?: string
  lastSyncedAt?: number
}

export interface MappingResult {
  helixItemId: string
  arrMovie?: ArrMovieSummary
  arrSeries?: ArrSeriesSummary
}

export interface SyncResult {
  itemsFetched: number
  itemsMapped: number
  linksCreated: number
  linksUpdated: number
  errors: string[]
}
