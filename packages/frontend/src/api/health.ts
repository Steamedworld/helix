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
}

export function getHealth() {
  return apiFetch<HealthResponse>('/api/v1/health')
}
