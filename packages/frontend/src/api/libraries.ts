import type { Library, LibraryKind } from '@helix/shared'
import { apiFetch } from './client'

export function listLibraries() {
  return apiFetch<Library[]>('/api/v1/libraries')
}

export function getLibrary(id: string) {
  return apiFetch<Library>(`/api/v1/libraries/${id}`)
}

export function createLibrary(body: { name: string; kind: LibraryKind; root_path: string }) {
  return apiFetch<Library>('/api/v1/libraries', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateLibrary(id: string, body: Partial<{ name: string; kind: LibraryKind; root_path: string }>) {
  return apiFetch<Library>(`/api/v1/libraries/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function deleteLibrary(id: string) {
  return apiFetch<{ deleted: boolean }>(`/api/v1/libraries/${id}`, {
    method: 'DELETE',
  })
}

export function triggerScan(id: string) {
  return apiFetch<{ started: boolean }>(`/api/v1/libraries/${id}/scan`, {
    method: 'POST',
  })
}

export function getScanStatus(id: string) {
  return apiFetch<{ scan_status: string; item_count: number }>(`/api/v1/libraries/${id}/scan-status`)
}
