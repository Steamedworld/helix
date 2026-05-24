import type { ApiSuccess, ApiError } from '@helix/shared'

export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data }
}

export function err(message: string, details?: unknown): ApiError {
  return { ok: false, error: message, details }
}
