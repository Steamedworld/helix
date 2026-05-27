import type { PlaybackSession } from '@helix/shared'
import { apiFetch } from './client'

export type PlaybackCode =
  | 'local_playable'
  | 'remote_available'
  | 'remote_playback_unsupported'
  | 'unavailable'

export interface PlaybackSource {
  code: 'local_playable'
  nodeId: string
  nodeBaseUrl: string | null
  nodeKind: 'local'
  nodeName: string
  mediaItemId: string
  selectedVersionId: string
  selectedFileId: string
  fileId: string
  versionId: string
  filePath: string
  filename: string
  container: string | null
  quality_label: string | null
  resolution_width: number | null
  resolution_height: number | null
  video_codec: string | null
  audio_codec: string | null
  streamUrl: string
  score: number
}

export interface PlaybackSourceAvailable {
  source: PlaybackSource
  unavailable?: never
}

export interface PlaybackSourceUnavailable {
  source?: never
  unavailable: true
  code: PlaybackCode
  reason: string
  nodeId: string | null
  nodeName: string | null
  nodeKind: 'local' | 'remote' | null
}

export type PlaybackSourceResult = PlaybackSourceAvailable | PlaybackSourceUnavailable

export function getPlaybackSource(mediaItemId: string) {
  return apiFetch<PlaybackSourceResult>(`/api/v1/media/${mediaItemId}/playback-source`)
}

export function createPlaybackSession(body: {
  media_item_id: string
  media_version_id: string
  media_file_id: string
}) {
  return apiFetch<PlaybackSession>('/api/v1/playback-sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updatePlaybackSession(
  sessionId: string,
  body: { state?: 'starting' | 'playing' | 'paused' | 'stopped' | 'error'; position_seconds?: number }
) {
  return apiFetch<PlaybackSession>(`/api/v1/playback-sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}
