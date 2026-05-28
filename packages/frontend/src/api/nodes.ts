import { apiFetch } from './client'

export interface NodeCapabilities {
  nodeId: string
  nodeName: string
  version: string
  federationProtocolVersion: string
  supportsCatalogSync: boolean
  supportsArtworkProxy: boolean
  supportsRemotePlayback: boolean
  supportedPlaybackModes: string[]
  supportsSignedPlaybackUrls: boolean
  directPlaybackUrlTtlSeconds: number
  baseUrlConfigured: boolean
  publicBaseUrl?: string
  directPlaybackRequiresBrowserReachability: true
}

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
  capabilities: NodeCapabilities | null
  created_at: string
  updated_at: string
}

export interface DirectPlaybackDiagnostic {
  directPlaybackAvailable: boolean
  supportsRemotePlayback: boolean
  baseUrlConfigured: boolean
  publicBaseUrl: string | null
  warning?: string
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

export function checkNodePlayback(id: string) {
  return apiFetch<DirectPlaybackDiagnostic>(`/api/v1/nodes/${id}/check`)
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

// ─── Trusted Home invite API ───────────────────────────────────────────────────

export interface InvitePayload {
  helix_invite: '1'
  home_name: string
  server_address: string
  token: string
  invite_id: string
  label: string | null
  expires_at: string | null
  generated_at: string
  warning: string
}

export interface InviteSummary {
  id: string
  label: string | null
  created_at: number
  expires_at: number | null
  used_at: number | null
  revoked_at: number | null
  used_by_home_name: string | null
  used_by_address: string | null
  created_by_user_id: string
}

export interface CreateInviteResponse {
  invite: InvitePayload
  compact: string
  base_url_warning?: string
}

export interface AcceptInviteResponse {
  connected?: boolean
  already_connected?: boolean
  node_id: string
  node_name?: string
  server_address?: string
  message?: string
  sync_available?: boolean
  sync_result?: { items_synced: number }
  sync_warning?: string
  consume_warning?: string
  node_status?: string
}

export interface VerifyInviteResponse {
  valid: boolean
  home_name: string
  server_address: string
  capabilities: { federation: boolean; catalog: boolean; artwork: boolean; playback: boolean }
  label: string | null
  expires_at: string | null
  invite_id: string
}

export function createInvite(body: { label?: string; expires_in_days?: number }) {
  return apiFetch<CreateInviteResponse>('/api/v1/trusted-home-invites', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function listInvites() {
  return apiFetch<InviteSummary[]>('/api/v1/trusted-home-invites')
}

export function revokeInvite(id: string) {
  return apiFetch<{ revoked: boolean; id: string }>(
    `/api/v1/trusted-home-invites/${id}`,
    { method: 'DELETE' }
  )
}

export function acceptInvite(invite: string, syncNow = false) {
  return apiFetch<AcceptInviteResponse>('/api/v1/trusted-homes/accept-invite', {
    method: 'POST',
    body: JSON.stringify({ invite, syncNow }),
  })
}
