import { apiFetch } from './client'

export interface HealthResponse {
  status: string
  version: string
  node: string
  autoSync: {
    enabled: boolean
    intervalMs: number
  }
  tombstoneRetentionDays?: number
  trustedHomeSync?: {
    total: number
    healthy: number
    failing: number
    stale: number
    neverSynced: number
    unknown: number
    hasFailures: boolean
    syncStatus: 'ok' | 'degraded' | 'unknown'
    tombstoneRetentionDays: number
    oldestActiveErrorAt: string | null
    newestAttemptAt: string | null
  }
}

export function getHealth() {
  return apiFetch<HealthResponse>('/api/v1/health')
}
