// ─── Safe sync error classifier ───────────────────────────────────────────────
//
// Rules:
//   - safeMessage is ALWAYS one of the fixed string literals below.
//   - NEVER include raw error text, tokens, URLs, file paths, or stack traces in safeMessage.
//   - The code is a safe enum value, never a raw HTTP status or OS error code.

export type SyncErrorCode =
  | 'remote_unreachable'
  | 'auth_failed'
  | 'remote_catalog_failed'
  | 'remote_no_since_support'
  | 'timeout'
  | 'network_error'
  | 'invalid_remote_response'
  | 'unknown'

export interface ClassifiedSyncError {
  code: SyncErrorCode
  safeMessage: string
}

// Fixed safe messages — no interpolation, no raw details
const SAFE_MESSAGES = {
  remote_unreachable: 'Remote home is unreachable.',
  auth_failed: 'Remote home rejected the trusted-home token.',
  remote_catalog_failed: 'Remote catalog request failed.',
  remote_no_since_support: 'Remote home does not support incremental sync.',
  timeout: 'Remote home did not respond in time.',
  network_error: 'Network error while contacting remote home.',
  invalid_remote_response: 'Remote home returned an invalid response.',
  unknown: 'Sync failed.',
} as const satisfies Record<SyncErrorCode, string>

function extractHttpStatus(error: unknown): number | null {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>
    // Some custom error shapes carry statusCode/status
    if (typeof e.statusCode === 'number') return e.statusCode
    if (typeof e.status === 'number') return e.status
  }
  return null
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return ''
}

export function classifySyncError(error: unknown): ClassifiedSyncError {
  const msg = extractMessage(error).toLowerCase()
  const httpStatus = extractHttpStatus(error)

  // ── HTTP status from error object property ──────────────────────────────────

  // HTTP 401 / 403 → auth failed
  if (httpStatus === 401 || httpStatus === 403) {
    return { code: 'auth_failed', safeMessage: SAFE_MESSAGES.auth_failed }
  }

  // HTTP 404 → unreachable (endpoint not found on remote)
  if (httpStatus === 404) {
    return { code: 'remote_unreachable', safeMessage: SAFE_MESSAGES.remote_unreachable }
  }

  // HTTP 400 with since-related message → remote_no_since_support
  if (httpStatus === 400 && (msg.includes('since') || msg.includes('incremental'))) {
    return { code: 'remote_no_since_support', safeMessage: SAFE_MESSAGES.remote_no_since_support }
  }

  // HTTP 5xx → remote catalog failed
  if (httpStatus !== null && httpStatus >= 500 && httpStatus < 600) {
    return { code: 'remote_catalog_failed', safeMessage: SAFE_MESSAGES.remote_catalog_failed }
  }

  // Any other HTTP failure code → catalog failed
  if (httpStatus !== null && !isNaN(httpStatus)) {
    return { code: 'remote_catalog_failed', safeMessage: SAFE_MESSAGES.remote_catalog_failed }
  }

  // ── HTTP status embedded in the error message string ────────────────────────
  // Check this BEFORE generic network-error patterns, because the error messages
  // from fetchRemoteCatalog look like "Remote catalog fetch failed: HTTP 401 ..."
  // which contain "fetch failed" but should be classified by status, not as network.

  const httpMatch = msg.match(/http\s+(\d{3})/)
  if (httpMatch) {
    const status = parseInt(httpMatch[1], 10)
    if (status === 401 || status === 403) {
      return { code: 'auth_failed', safeMessage: SAFE_MESSAGES.auth_failed }
    }
    if (status === 404) {
      return { code: 'remote_unreachable', safeMessage: SAFE_MESSAGES.remote_unreachable }
    }
    if (status === 400 && (msg.includes('since') || msg.includes('incremental'))) {
      return { code: 'remote_no_since_support', safeMessage: SAFE_MESSAGES.remote_no_since_support }
    }
    if (status >= 500) {
      return { code: 'remote_catalog_failed', safeMessage: SAFE_MESSAGES.remote_catalog_failed }
    }
    return { code: 'remote_catalog_failed', safeMessage: SAFE_MESSAGES.remote_catalog_failed }
  }

  // ── Timeout ─────────────────────────────────────────────────────────────────

  if (
    (error instanceof Error && error.name === 'AbortError') ||
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('timed out')
  ) {
    return { code: 'timeout', safeMessage: SAFE_MESSAGES.timeout }
  }

  // ── Network / connection errors ─────────────────────────────────────────────

  if (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('econnreset') ||
    msg.includes('enetunreach') ||
    msg.includes('ehostunreach')
  ) {
    return { code: 'remote_unreachable', safeMessage: SAFE_MESSAGES.remote_unreachable }
  }

  if (
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('failed to fetch') ||
    msg.includes('no response')
  ) {
    return { code: 'network_error', safeMessage: SAFE_MESSAGES.network_error }
  }

  // TypeError (e.g. "TypeError: fetch failed" from Node fetch) is a network-level error
  if (error instanceof TypeError) {
    return { code: 'network_error', safeMessage: SAFE_MESSAGES.network_error }
  }

  // ── JSON parse / schema validation errors ───────────────────────────────────

  if (
    error instanceof SyntaxError ||
    msg.includes('unexpected token') ||
    msg.includes('invalid json') ||
    msg.includes('invalid response') ||
    (msg.includes('json') && !msg.includes('remote catalog'))
  ) {
    return { code: 'invalid_remote_response', safeMessage: SAFE_MESSAGES.invalid_remote_response }
  }

  // ── Remote catalog error messages ───────────────────────────────────────────

  if (msg.includes('remote catalog') || msg.includes('catalog error')) {
    return { code: 'remote_catalog_failed', safeMessage: SAFE_MESSAGES.remote_catalog_failed }
  }

  return { code: 'unknown', safeMessage: SAFE_MESSAGES.unknown }
}
