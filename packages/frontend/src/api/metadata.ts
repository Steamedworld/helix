import { apiFetch } from './client'

// ─── Provider types ─────────────────────────────────────────────────────────────

export interface ProviderInfo {
  id: string
  label: string
  status: 'configured' | 'unconfigured' | 'error'
  supportedKinds: string[]
}

// ─── Candidate types ────────────────────────────────────────────────────────────

export interface MetadataCandidate {
  providerId: string
  externalId: string
  title: string
  originalTitle?: string
  year?: number
  overview?: string
  score: number
  posterUrl?: string
  backdropUrl?: string
}

// ─── Enrichment result ──────────────────────────────────────────────────────────

export interface EnrichmentResult {
  mediaItemId: string
  status: 'matched' | 'needs_review' | 'no_provider' | 'skipped' | 'error'
  candidate?: MetadataCandidate
  error?: string
}

// ─── API calls ──────────────────────────────────────────────────────────────────

export function listProviders() {
  return apiFetch<{ providers: ProviderInfo[] }>('/api/v1/metadata/providers')
}

export function searchMetadata(mediaItemId: string) {
  return apiFetch<{ candidates: MetadataCandidate[] }>(
    `/api/v1/media/${mediaItemId}/metadata/search`
  )
}

export function matchMetadata(mediaItemId: string, providerId: string, externalId: string) {
  return apiFetch<{ result: EnrichmentResult; item: unknown }>(
    `/api/v1/media/${mediaItemId}/metadata/match`,
    {
      method: 'POST',
      body: JSON.stringify({ providerId, externalId }),
    }
  )
}

export function refreshMetadata(mediaItemId: string) {
  return apiFetch<EnrichmentResult>(`/api/v1/media/${mediaItemId}/metadata/refresh`, {
    method: 'POST',
  })
}

export function bulkEnrich(limit = 20) {
  return apiFetch<{ results: EnrichmentResult[]; count: number }>('/api/v1/metadata/enrich', {
    method: 'POST',
    body: JSON.stringify({ limit }),
  })
}
