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
  watchState?: EpisodeWatchState | null
}

export interface EpisodeDetail extends EpisodeListItem {
  showId: string
  showTitle: string
  seasonId: string
  metadataStatus: string
  showMetadataStatus: string
  airDate: string | null
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

export function getSeasonEpisodes(seasonId: string, userId?: string) {
  const qs = userId ? `?user_id=${encodeURIComponent(userId)}` : ''
  return apiFetch<EpisodeListItem[]>(`/api/v1/seasons/${seasonId}/episodes${qs}`)
}

export function getEpisode(id: string) {
  return apiFetch<EpisodeDetail>(`/api/v1/episodes/${id}`)
}
