import { apiFetch } from './client'

export interface LibraryPermission {
  id: string
  library_id: string
  user_id: string
  can_view: boolean
  can_play: boolean
  created_at: string
  updated_at: string
  username: string
  display_name: string | null
}

export interface UserRecord {
  id: string
  username: string
  display_name: string | null
  role: 'admin' | 'user'
  created_at: string
  updated_at: string
}

export function listLibraryPermissions(libraryId: string) {
  return apiFetch<LibraryPermission[]>(`/api/v1/libraries/${libraryId}/permissions`)
}

export function setLibraryPermission(
  libraryId: string,
  userId: string,
  body: { can_view: boolean; can_play: boolean }
) {
  return apiFetch<{ id: string }>(`/api/v1/libraries/${libraryId}/permissions/${userId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function revokeLibraryPermission(libraryId: string, userId: string) {
  return apiFetch<{ deleted: boolean }>(`/api/v1/libraries/${libraryId}/permissions/${userId}`, {
    method: 'DELETE',
  })
}

export function listUsers() {
  return apiFetch<UserRecord[]>('/api/v1/users')
}
