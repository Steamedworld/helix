import type { PlaybackSession } from '@helix/shared'
import { apiFetch } from './client'

export type PlaybackCode =
  | 'local_playable'
  | 'remote_direct'
  | 'remote_available'
  | 'remote_playback_unsupported'
  | 'unavailable'

export interface LocalPlaybackSource {
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
  filePath?: string
  filename: string
  container: string | null
  quality_label: string | null
  resolution_width: number | null
  resolution_height: number | null
  video_codec: string | null
  audio_codec: string | null
  streamUrl: string
  score: number
  /** ISO timestamp — when the signed stream URL expires. Optional for older server compat. */
  expiresAt?: string
  /** ISO timestamp — when the client should proactively refresh (75% of TTL). Optional for older server compat. */
  refreshAfter?: string
  /** Total TTL of the signed token in seconds. Optional for older server compat. */
  tokenTtlSeconds?: number
}

export interface RemoteDirectPlaybackSource {
  code: 'remote_direct'
  sourceType: 'remote_direct'
  nodeId: string
  nodeName: string
  streamUrl: string
  expiresAt: string
  /** ISO timestamp — when the client should proactively refresh. Optional for older server compat. */
  refreshAfter?: string
  /** Total TTL of the signed token in seconds. Optional for older server compat. */
  tokenTtlSeconds?: number
  mediaFileId: string
  contentType: string | null
  container: string | null
  /**
   * Proxy stream URL — available when proxy is enabled.
   * The browser calls the local Helix server which relays the stream server-to-server.
   */
  proxyStreamUrl?: string
  /**
   * Endpoint to call to get a fresh PlaybackSource before the proxy URL expires.
   * Only present when proxyStreamUrl is set.
   */
  refreshUrl?: string
  /**
   * Direct stream URL from the remote node — only present when the source Home's
   * address appears to be publicly reachable (not private/loopback).
   * The player MUST NOT auto-switch to this URL — user must explicitly choose.
   */
  directStreamUrl?: string
  /** Informational warning — does not block playback. Present when the stream URL
   *  points to a loopback address that remote browsers may not be able to reach. */
  warning?: string
}

/** Union of all playable source shapes */
export type PlaybackSource = LocalPlaybackSource | RemoteDirectPlaybackSource

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
