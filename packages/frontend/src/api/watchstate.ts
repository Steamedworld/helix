import type { WatchState, MediaItem } from '@helix/shared'
import { apiFetch } from './client'

export interface MediaItemWithWatchState extends MediaItem {
  watch_state: WatchState
}

export function upsertWatchState(
  mediaItemId: string,
  body: {
    user_id: string
    position_seconds: number
    duration_seconds?: number
    completed?: boolean
  }
) {
  return apiFetch<WatchState>(`/api/v1/watchstate/${mediaItemId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function getContinueWatching(userId: string, limit = 20) {
  return apiFetch<MediaItemWithWatchState[]>(
    `/api/v1/watchstate/continue-watching?user_id=${encodeURIComponent(userId)}&limit=${limit}`
  )
}
