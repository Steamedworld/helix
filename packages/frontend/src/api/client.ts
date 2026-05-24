import type { ApiResponse } from '@helix/shared'

const BASE = import.meta.env.VITE_API_BASE ?? ''

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      ...init,
    })
    const json = await res.json()
    return json as ApiResponse<T>
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Network error',
    }
  }
}
