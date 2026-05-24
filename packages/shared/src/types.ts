export type NodeKind = 'local' | 'remote'
export type NodeStatus = 'online' | 'offline' | 'unknown'
export type LibraryKind = 'movies' | 'tv' | 'music' | 'photos' | 'other'
export type ScanStatus = 'idle' | 'scanning' | 'error'
export type MediaItemKind = 'movie' | 'show' | 'season' | 'episode' | 'track' | 'album' | 'photo' | 'other'
export type UserRole = 'admin' | 'user'
export type PlaybackState = 'starting' | 'playing' | 'paused' | 'stopped' | 'error'

export interface Node {
  id: string
  name: string
  kind: NodeKind
  base_url: string | null
  status: NodeStatus
  created_at: string
  updated_at: string
}

export interface Library {
  id: string
  node_id: string
  name: string
  kind: LibraryKind
  root_path: string
  scan_status: ScanStatus
  created_at: string
  updated_at: string
}

export interface MediaItem {
  id: string
  kind: MediaItemKind
  title: string
  sort_title: string | null
  year: number | null
  external_tmdb_id: string | null
  external_tvdb_id: string | null
  external_musicbrainz_id: string | null
  created_at: string
  updated_at: string
}

export interface MediaVersion {
  id: string
  media_item_id: string
  label: string | null
  quality_label: string | null
  resolution_width: number | null
  resolution_height: number | null
  video_codec: string | null
  audio_codec: string | null
  container: string | null
  duration_seconds: number | null
  created_at: string
  updated_at: string
}

export interface MediaFile {
  id: string
  node_id: string
  library_id: string
  media_item_id: string
  media_version_id: string
  path: string
  filename: string
  extension: string
  size_bytes: number | null
  file_hash: string | null
  discovered_at: string
  updated_at: string
}

export interface User {
  id: string
  display_name: string
  role: UserRole
  created_at: string
  updated_at: string
}

export interface WatchState {
  id: string
  user_id: string
  media_item_id: string
  position_seconds: number
  duration_seconds: number | null
  completed: boolean
  updated_at: string
}

export interface PlaybackSession {
  id: string
  user_id: string
  node_id: string
  media_item_id: string
  media_version_id: string
  media_file_id: string
  state: PlaybackState
  started_at: string
  updated_at: string
}

// API response wrappers
export interface ApiSuccess<T> {
  ok: true
  data: T
}

export interface ApiError {
  ok: false
  error: string
  details?: unknown
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError
