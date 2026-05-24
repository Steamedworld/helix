import { apiFetch } from './client'

export interface ShowListItem {
  id: string
  title: string
  year: number | null
  posterUrl: string | null
  backdropUrl: string | null
  episodeCount: number
  overview: string | null
  metadataStatus: string
}

export interface SeasonSummary {
  id: string
  seasonNumber: number
  episodeCount: number
  posterUrl: string | null
  overview: string | null
}

export interface ShowIntegrationLink {
  kind: string
  integrationName: string
  monitored: boolean
  qualityProfile: string | null
  externalTitle: string | null
}

export interface ShowDetail {
  id: string
  title: string
  year: number | null
  posterUrl: string | null
  backdropUrl: string | null
  overview: string | null
  contentRating: string | null
  metadataStatus: string
  seasons: SeasonSummary[]
  integrationLinks?: ShowIntegrationLink[]
}

export interface EpisodeWatchState {
  position_seconds: number
  duration_seconds: number | null
  completed: boolean
}

export interface EpisodeListItem {
  id: string
  episodeNumber: number
  seasonNumber: number
  title: string
  episodeTitle: string | null
  overview: string | null
  runtime: number | null
  posterUrl: string | null
  hasPlayableFile: boolean
  watchState?: EpisodeWatchState | null
}

export interface EpisodeDetail extends EpisodeListItem {
  showId: string
  showTitle: string
  seasonId: string
  metadataStatus: string
  showMetadataStatus: string
  airDate: string | null
  // hasPlayableFile is inherited from EpisodeListItem
}

export function listShows(libraryId?: string) {
  const qs = libraryId ? `?library_id=${encodeURIComponent(libraryId)}` : ''
  return apiFetch<ShowListItem[]>(`/api/v1/shows${qs}`)
}

export function getShow(id: string) {
  return apiFetch<ShowDetail>(`/api/v1/shows/${id}`)
}

export function getShowSeasons(id: string) {
  return apiFetch<SeasonSummary[]>(`/api/v1/shows/${id}/seasons`)
}

export function getSeasonEpisodes(seasonId: string) {
  return apiFetch<EpisodeListItem[]>(`/api/v1/seasons/${seasonId}/episodes`)
}

export function getEpisode(id: string) {
  return apiFetch<EpisodeDetail>(`/api/v1/episodes/${id}`)
}

// ─── Continuity types ──────────────────────────────────────────────────────────

export interface PlayableEpisode {
  id: string
  showId: string
  showTitle: string
  seasonId: string
  seasonNumber: number
  episodeNumber: number
  title: string
  overview?: string
  airDate?: string
  runtimeSeconds?: number
  posterUrl: string | null
  watchState?: {
    position: number
    duration: number
    completed: boolean
    updatedAt: number
  }
  hasPlayableFile: boolean
}

export interface ShowProgressData {
  totalEpisodes: number
  completedEpisodes: number
  inProgressEpisode: PlayableEpisode | null
  percentComplete: number
  allCompleted: boolean
}

export type UpNextResponse =
  | { episode: PlayableEpisode; allCompleted?: never }
  | { allCompleted: true; totalEpisodes: number; restartEpisodeId?: string; episode?: never }
  | { allCompleted: false; totalEpisodes: number; episode?: never }

// ─── Continuity API calls ─────────────────────────────────────────────────────

export function getShowUpNext(showId: string) {
  return apiFetch<UpNextResponse>(`/api/v1/shows/${showId}/up-next`)
}

export function getShowProgress(showId: string) {
  return apiFetch<ShowProgressData>(`/api/v1/shows/${showId}/progress`)
}

export function getNextEpisode(episodeId: string) {
  return apiFetch<{ episode: PlayableEpisode }>(`/api/v1/episodes/${episodeId}/next`)
}
