import { apiFetch } from './client'

export interface QueueStats {
  pending: number
  running: number
  done: number
  failed: number
  recentFailed: Array<{
    id: string
    mediaItemId: string
    lastError: string | null
    updatedAt: number
  }>
}

export function getQueueStats() {
  return apiFetch<QueueStats>('/api/v1/enrichment-queue/stats')
}

export function clearQueue() {
  return apiFetch<{ removed: number }>('/api/v1/enrichment-queue/clear', {
    method: 'POST',
  })
}

export function enqueueAll() {
  return apiFetch<{ enqueued: number }>('/api/v1/enrichment-queue/enqueue', {
    method: 'POST',
  })
}
