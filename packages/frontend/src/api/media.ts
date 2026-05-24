import type { MediaItem, MediaVersion, MediaFile, MediaItemKind } from '@helix/shared'
import { apiFetch } from './client'

export interface MediaItemDetail extends MediaItem {
  versions: MediaVersion[]
  files: MediaFile[]
}

export interface ListMediaParams {
  library_id?: string
  kind?: MediaItemKind
  q?: string
  limit?: number
  offset?: number
}

export function listMedia(params: ListMediaParams = {}) {
  const qs = new URLSearchParams()
  if (params.library_id) qs.set('library_id', params.library_id)
  if (params.kind) qs.set('kind', params.kind)
  if (params.q) qs.set('q', params.q)
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  if (params.offset !== undefined) qs.set('offset', String(params.offset))
  const query = qs.toString()
  return apiFetch<MediaItem[]>(`/api/v1/media${query ? `?${query}` : ''}`)
}

export function getMediaItem(id: string) {
  return apiFetch<MediaItemDetail>(`/api/v1/media/${id}`)
}

export function getMediaVersions(id: string) {
  return apiFetch<MediaVersion[]>(`/api/v1/media/${id}/versions`)
}

export function getMediaFiles(id: string) {
  return apiFetch<MediaFile[]>(`/api/v1/media/${id}/files`)
}
