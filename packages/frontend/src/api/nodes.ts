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

export interface PlaybackIssueDiagnostic {
  at: string
  mode: string
  code: 'remote_unreachable' | 'remote_unauthorized' | 'range_failed' | 'proxy_disabled' | 'unknown'
  safeMessage: string
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
  /** Present only when there is an active (uncleared) playback issue for this Home. */
  lastPlaybackIssue: PlaybackIssueDiagnostic | null
  /** Progress sync settings (both default false — bilateral opt-in) */
  progressSyncEnabled: boolean
  allowProgressPush: boolean
  allowProgressReceive: boolean
  created_at: string
  updated_at: string
}

export interface RemotePlaybackDiagnostic {
  proxyAvailable: boolean
  directPlaybackAvailable: boolean
  recommendedMode: 'proxy' | 'direct' | 'unavailable'
  warnings: string[]
}

export interface DirectPlaybackDiagnostic {
  directPlaybackAvailable: boolean
  supportsRemotePlayback: boolean
  baseUrlConfigured: boolean
  publicBaseUrl: string | null
  warning?: string
  remotePlayback?: RemotePlaybackDiagnostic
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

export interface DisconnectSummary {
  nodeRemoved: boolean
  librariesRemoved: number
  mediaItemsRemoved: number
  mediaFilesRemoved: number
  grantsRemoved: number
}

export function deleteNode(id: string) {
  return apiFetch<DisconnectSummary>(`/api/v1/nodes/${id}`, {
    method: 'DELETE',
  })
}

export interface BulkRevokeResponse {
  grantsRemoved: number
}

export function revokeNodeAccess(nodeId: string) {
  return apiFetch<BulkRevokeResponse>(`/api/v1/nodes/${nodeId}/access`, {
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

export interface SyncResponse {
  synced: boolean
  fullSync: boolean
  incremental: boolean
  sinceUsed: string | null
  itemsSynced: number
  versionsSynced: number
  filesSynced: number
  librariesSynced: number
  fallbackUsed: boolean
  fallbackReason?: string
  tombstoneRetentionDays?: number
  incrementalSince?: string | null
  tombstonesApplied?: number
  itemsRemoved?: number
  versionsRemoved?: number
  filesRemoved?: number
  librariesRemoved?: number
}

export function syncNode(id: string, force = false) {
  const url = force ? `/api/v1/nodes/${id}/sync?force=true` : `/api/v1/nodes/${id}/sync`
  return apiFetch<SyncResponse>(url, { method: 'POST' })
}

export function forceFullSync(id: string) {
  return apiFetch<SyncResponse>(`/api/v1/nodes/${id}/sync?force=true`, { method: 'POST' })
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

// ─── Trusted Home access management API ───────────────────────────────────────

export interface AccessGrant {
  userId: string
  userName: string
  canView: boolean
  canPlay: boolean
}

export interface UngrantedUser {
  userId: string
  userName: string
}

export interface AccessLibrarySummary {
  id: string
  name: string
  kind: string
  grants: AccessGrant[]
  ungrantedUsers: UngrantedUser[]
}

export interface AccessSummary {
  node: { id: string; name: string; address: string | null }
  libraries: AccessLibrarySummary[]
}

export interface AccessUpdateGrant {
  libraryId: string
  userId: string
  canView: boolean
  canPlay: boolean
}

export interface AccessUpdateResponse {
  updated: boolean
  libraries: AccessLibrarySummary[]
}

export function getNodeAccessSummary(nodeId: string) {
  return apiFetch<AccessSummary>(`/api/v1/nodes/${nodeId}/access-summary`)
}

export function updateNodeAccess(nodeId: string, grants: AccessUpdateGrant[]) {
  return apiFetch<AccessUpdateResponse>(`/api/v1/nodes/${nodeId}/access`, {
    method: 'PUT',
    body: JSON.stringify({ grants }),
  })
}

// ─── Admin sync diagnostics ────────────────────────────────────────────────────

export interface SyncDiagnosticsTombstoneStats {
  total: number
  byEntityType: Record<string, number>
  ageBuckets: {
    under7Days: number
    days7To30: number
    days30ToRetention: number
    olderThanRetention: number
  }
  oldestDeletedAt: string | null
  newestDeletedAt: string | null
  tombstoneRetentionDays: number
  pruneCutoff: string
}

export interface SyncDiagnosticsSyncCounts {
  itemsSynced: number
  versionsSynced: number
  filesSynced: number
  tombstonesApplied: number
  librariesRemoved: number
  itemsRemoved: number
  versionsRemoved: number
  filesRemoved: number
}

export interface SyncDiagnosticsHomeEntry {
  nodeId: string
  name: string
  status: string
  lastSuccessfulSyncAt: string | null
  lastSyncMode: string | null
  lastFallbackReason: string | null
  lastSyncCounts: SyncDiagnosticsSyncCounts
  tombstoneRetentionDays: number
  incrementalSafeNow: boolean
  nextSyncModeEstimate: 'full' | 'incremental'
  nextSyncReason: 'no_last_sync' | 'tombstone_retention_exceeded' | 'within_retention'
  lastSyncAttemptAt?: string | null
  lastSyncErrorAt?: string | null
  lastSyncErrorCode?: string | null
  lastSyncErrorMessage?: string | null
  hasActiveSyncError: boolean
  syncHealth: 'healthy' | 'never_synced' | 'failing' | 'stale' | 'unknown'
}

export interface RefreshSecretHealthEntry {
  /** State label — never includes the secret value, hash, or env var contents */
  state: 'explicit_secret' | 'derived_fallback' | 'dev_random' | 'missing'
  recommendation?: string
}

export interface SecretsHealthResponse {
  playbackRefreshToken: RefreshSecretHealthEntry
}

export interface SyncDiagnosticsResponse {
  tombstoneStats: SyncDiagnosticsTombstoneStats
  trustedHomeSync: SyncDiagnosticsHomeEntry[]
  secretsHealth?: SecretsHealthResponse
}

export interface NodeSettingsUpdateRequest {
  progressSyncEnabled?: boolean
  allowProgressPush?: boolean
  allowProgressReceive?: boolean
}

export interface NodeSettingsSummary {
  id: string
  name: string
  kind: string
  progressSyncEnabled: boolean
  allowProgressPush: boolean
  allowProgressReceive: boolean
}

export function getSyncDiagnostics() {
  return apiFetch<SyncDiagnosticsResponse>('/api/v1/admin/sync-diagnostics')
}

export function updateNodeSettings(nodeId: string, settings: NodeSettingsUpdateRequest) {
  return apiFetch<NodeSettingsSummary>(`/api/v1/nodes/${nodeId}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(settings),
  })
}
