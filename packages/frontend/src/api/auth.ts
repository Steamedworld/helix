import { apiFetch } from './client'

export interface AuthUser {
  id: string
  username: string
  display_name: string
  role: 'admin' | 'user'
}

export interface AuthStatus {
  setupRequired: boolean
  authenticated: boolean
  user?: AuthUser
}

export function getAuthStatus() {
  return apiFetch<AuthStatus>('/api/v1/auth/status')
}

export function setupAdmin(username: string, password: string) {
  return apiFetch<{ user: AuthUser }>('/api/v1/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    credentials: 'include',
  })
}

export function login(username: string, password: string) {
  return apiFetch<{ user: AuthUser }>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    credentials: 'include',
  })
}

export function logout() {
  return apiFetch<Record<string, never>>('/api/v1/auth/logout', {
    method: 'POST',
    credentials: 'include',
  })
}

export function getMe() {
  return apiFetch<AuthUser>('/api/v1/auth/me', {
    credentials: 'include',
  })
}

export function changePassword(currentPassword: string, newPassword: string) {
  return apiFetch<Record<string, never>>('/api/v1/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
    credentials: 'include',
  })
}
