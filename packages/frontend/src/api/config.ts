import { apiFetch } from './client'

export interface ServerConfig {
  baseUrl: string | null
  baseUrlConfigured: boolean
  baseUrlIsLoopback: boolean
}

export function getServerConfig() {
  return apiFetch<ServerConfig>('/api/v1/config')
}
