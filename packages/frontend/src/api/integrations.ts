import { apiFetch } from './client'

export type IntegrationKind = 'radarr' | 'sonarr' | 'lidarr' | 'prowlarr' | 'other'
export type IntegrationStatus = 'unknown' | 'online' | 'offline' | 'error'

export interface Integration {
  id: string
  kind: IntegrationKind
  name: string
  baseUrl: string
  apiKeyMasked: string
  enabled: boolean
  status: IntegrationStatus
  lastCheckedAt: number | null
  lastSyncedAt: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface IntegrationTestResult {
  ok: boolean
  version?: string
  error?: string
}

export interface SyncResult {
  itemsFetched: number
  itemsMapped: number
  linksCreated: number
  linksUpdated: number
  errors: string[]
}

export interface ExternalLink {
  id: string
  mediaItemId: string
  integrationId: string
  externalKind: string
  externalId: string
  externalTitle: string | null
  monitored: boolean
  qualityProfile: string | null
  rootPath: string | null
  lastSyncedAt: number | null
}

export interface CreateIntegrationParams {
  kind: IntegrationKind
  name: string
  baseUrl: string
  apiKey: string
  enabled?: boolean
}

export interface UpdateIntegrationParams {
  name?: string
  baseUrl?: string
  apiKey?: string
  enabled?: boolean
}

export function listIntegrations() {
  return apiFetch<Integration[]>('/api/v1/integrations')
}

export function getIntegration(id: string) {
  return apiFetch<Integration>(`/api/v1/integrations/${id}`)
}

export function createIntegration(params: CreateIntegrationParams) {
  return apiFetch<Integration>('/api/v1/integrations', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

export function updateIntegration(id: string, params: UpdateIntegrationParams) {
  return apiFetch<Integration>(`/api/v1/integrations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(params),
  })
}

export function deleteIntegration(id: string) {
  return apiFetch<{ deleted: boolean }>(`/api/v1/integrations/${id}`, {
    method: 'DELETE',
  })
}

export function testIntegration(id: string) {
  return apiFetch<{ integration: Integration; testResult: IntegrationTestResult }>(
    `/api/v1/integrations/${id}/test`,
    { method: 'POST' }
  )
}

export function syncIntegration(id: string) {
  return apiFetch<SyncResult>(`/api/v1/integrations/${id}/sync`, {
    method: 'POST',
  })
}

export function listIntegrationItems(id: string) {
  return apiFetch<ExternalLink[]>(`/api/v1/integrations/${id}/items`)
}
