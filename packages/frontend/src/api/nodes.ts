import { apiFetch } from './client'

export interface NodeRecord {
  id: string
  name: string
  kind: 'local' | 'remote'
  base_url: string | null
  status: 'online' | 'offline' | 'unknown' | 'error'
  last_seen_at: number | null
  last_sync_at: number | null
  last_error: string | null
  has_federation_token: boolean
  created_at: string
  updated_at: string
}

export function listNodes() {
  return apiFetch<NodeRecord[]>('/api/v1/nodes')
}

export function getNode(id: string) {
  return apiFetch<NodeRecord>(`/api/v1/nodes/${id}`)
}

export function createNode(body: { name: string; base_url: string; api_token: string }) {
  return apiFetch<NodeRecord>('/api/v1/nodes', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateNode(
  id: string,
  body: Partial<{ name: string; base_url: string; api_token: string }>
) {
  return apiFetch<NodeRecord>(`/api/v1/nodes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteNode(id: string) {
  return apiFetch<{ deleted: boolean }>(`/api/v1/nodes/${id}`, {
    method: 'DELETE',
  })
}

export function testNode(id: string) {
  return apiFetch<{ online: boolean; error?: string }>(`/api/v1/nodes/${id}/test`, {
    method: 'POST',
  })
}

export function syncNode(id: string) {
  return apiFetch<{ synced: boolean; librariesSynced: number; itemsSynced: number }>(
    `/api/v1/nodes/${id}/sync`,
    { method: 'POST' }
  )
}

export interface FederationTokenStatus {
  hasToken: boolean
}

export function getFederationTokenStatus() {
  return apiFetch<FederationTokenStatus>('/api/v1/federation/token')
}

export function generateFederationToken() {
  return apiFetch<{ token: string }>('/api/v1/federation/token', {
    method: 'POST',
  })
}

export function revokeFederationToken() {
  return apiFetch<{ revoked: boolean }>('/api/v1/federation/token', {
    method: 'DELETE',
  })
}
