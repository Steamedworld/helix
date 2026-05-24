import type { Node } from '@helix/shared'
import { apiFetch } from './client'

export function listNodes() {
  return apiFetch<Node[]>('/api/v1/nodes')
}

export function getNode(id: string) {
  return apiFetch<Node>(`/api/v1/nodes/${id}`)
}
