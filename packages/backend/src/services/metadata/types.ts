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

// ─── TV enriched types ───────────────────────────────────────────────────────

export interface EnrichedShowMetadata {
  externalId: string
  providerId: string
  title: string
  originalTitle?: string
  firstAirDate?: string        // YYYY-MM-DD
  overview?: string
  contentRating?: string
  posterUrl?: string           // remote URL
  backdropUrl?: string         // remote URL
  genres?: string[]
  status?: string              // Returning Series, Ended, Canceled, etc.
}

export interface EnrichedSeasonMetadata {
  externalShowId: string
  seasonNumber: number
  title?: string               // e.g. "Season 1" or TMDB season name
  overview?: string
  airDate?: string
  posterUrl?: string
}

export interface EnrichedEpisodeMetadata {
  externalShowId: string
  seasonNumber: number
  episodeNumber: number
  title?: string
  overview?: string
  airDate?: string
  runtimeMinutes?: number
  absoluteEpisodeNumber?: number
  stillUrl?: string            // episode still image (optional)
}

// ─── Artwork ─────────────────────────────────────────────────────────────────

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
  // ─── Optional TV methods (movie-only providers need not implement) ─────────
  searchShows?(title: string, year?: number): Promise<MetadataCandidate[]>
  getShowDetails?(externalShowId: string): Promise<EnrichedShowMetadata | null>
  getSeasonDetails?(externalShowId: string, seasonNumber: number): Promise<EnrichedSeasonMetadata | null>
  getEpisodeDetails?(externalShowId: string, seasonNumber: number, episodeNumber: number): Promise<EnrichedEpisodeMetadata | null>
  getShowArtwork?(externalShowId: string): Promise<ArtworkCandidate[]>
}
