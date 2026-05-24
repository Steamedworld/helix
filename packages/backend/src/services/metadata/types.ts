import type { MediaItemKind } from '@helix/shared'

export type ProviderConfigurationStatus = 'configured' | 'unconfigured' | 'error'

export interface MetadataCandidate {
  providerId: string
  externalId: string
  title: string
  originalTitle?: string
  year?: number
  overview?: string
  score: number // 0-1 match confidence
  posterUrl?: string  // remote URL (not yet downloaded)
  backdropUrl?: string // remote URL (not yet downloaded)
}

export interface EnrichedMovieMetadata {
  externalId: string
  providerId: string
  title: string
  originalTitle?: string
  releaseDate?: string // YYYY-MM-DD
  overview?: string
  runtimeMinutes?: number
  contentRating?: string
  posterUrl?: string  // remote
  backdropUrl?: string // remote
  genres?: string[]
}

export interface ArtworkCandidate {
  kind: 'poster' | 'backdrop'
  url: string
  width?: number
  height?: number
  language?: string
}

export interface ProviderInfo {
  id: string
  label: string
  status: ProviderConfigurationStatus
  supportedKinds: MediaItemKind[]
}

export interface MetadataProvider {
  id: string
  label: string
  supportedKinds: MediaItemKind[]
  configurationStatus: ProviderConfigurationStatus
  searchMovies(title: string, year?: number): Promise<MetadataCandidate[]>
  getMovieDetails(externalId: string): Promise<EnrichedMovieMetadata | null>
  getArtwork?(externalId: string): Promise<ArtworkCandidate[]>
  isConfigured(): boolean
}
