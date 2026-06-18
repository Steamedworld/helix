import { join } from 'path'
import { createHmac, randomBytes } from 'crypto'

// ─── BASE_URL validation ──────────────────────────────────────────────────────

function parseBaseUrl(): string | null {
  const raw = process.env.BASE_URL ?? process.env.PUBLIC_URL ?? null

  // Absent, empty, or Vite's injected default "/" — treat as not set
  if (!raw || raw === '/') return null

  // Must be absolute http/https URL
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(
      `BASE_URL must be an absolute HTTP/HTTPS URL (e.g. http://media-box.local:3000). Got: "${raw}"`
    )
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `BASE_URL must be an absolute HTTP/HTTPS URL (e.g. http://media-box.local:3000). Got: "${raw}"`
    )
  }

  // Normalize: strip trailing slash
  return raw.replace(/\/+$/, '')
}

export const configuredBaseUrl = parseBaseUrl()

// ─── Loopback detection ───────────────────────────────────────────────────────

export function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    // Note: URL.hostname for IPv6 includes brackets, e.g. "[::1]"
    const host = hostname.replace(/^\[|\]$/g, '')
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.startsWith('127.') ||
      host.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

/**
 * Returns true if the URL resolves to a private/non-routable address.
 * Used as a heuristic to decide whether directStreamUrl should be offered as a
 * browser-reachable fallback. When the source Home is on a private address,
 * the browser (on a different network) cannot reach it directly.
 *
 * Addresses matched:
 *   - Loopback (127.*, ::1, localhost)
 *   - RFC-1918 private: 10.*, 192.168.*, 172.16-31.*
 *   - Link-local: 169.254.*
 */
export function isPrivateUrl(url: string): boolean {
  if (isLoopbackUrl(url)) return true
  try {
    const { hostname } = new URL(url)
    const host = hostname.replace(/^\[|\]$/g, '')
    // 10.x.x.x
    if (/^10\./.test(host)) return true
    // 192.168.x.x
    if (/^192\.168\./.test(host)) return true
    // 172.16-31.x.x
    const m172 = host.match(/^172\.(\d+)\./)
    if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true
    // 169.254.x.x (link-local)
    if (/^169\.254\./.test(host)) return true
    return false
  } catch {
    return false
  }
}

/**
 * Resolve the HMAC-SHA256 secret used to sign playback refresh tokens.
 *
 * Resolution order:
 *   1. TRUSTED_HOME_PLAYBACK_REFRESH_SECRET — explicit, recommended.
 *   2. MEDIA_TOKEN_SECRET is present — derive a domain-separated key via
 *      HMAC(MEDIA_TOKEN_SECRET, "playback_refresh"). This ensures the same
 *      root secret cannot be used interchangeably across token types.
 *   3. Development only (NODE_ENV !== 'production') — generate a random
 *      per-process secret (tokens will not survive restarts).
 *   4. Production without any secret — throws a startup error.
 *
 * The returned secret is a hex string safe for use as an HMAC key.
 */
/**
 * Describes the resolution state of the playback refresh signing key.
 *
 *   explicit_secret  — TRUSTED_HOME_PLAYBACK_REFRESH_SECRET is set.
 *   derived_fallback — Derived from MEDIA_TOKEN_SECRET via HMAC domain-separation.
 *   dev_random       — Random per-process key (development only, non-production).
 *   missing          — No key available (would throw in production).
 *
 * MUST NOT be called in production when no secret is configured — call
 * resolvePlaybackRefreshSecret() for that (it throws appropriately).
 *
 * IMPORTANT: This function NEVER returns the secret value, hash, or any
 * env var contents — only the state label.
 */
export type RefreshSecretHealth = 'explicit_secret' | 'derived_fallback' | 'dev_random' | 'missing'

export function getPlaybackRefreshSecretHealth(): RefreshSecretHealth {
  if (process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET) {
    return 'explicit_secret'
  }
  if (process.env.MEDIA_TOKEN_SECRET) {
    return 'derived_fallback'
  }
  if (process.env.NODE_ENV === 'production') {
    return 'missing'
  }
  return 'dev_random'
}

export function resolvePlaybackRefreshSecret(): string {
  if (process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET) {
    return process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET
  }
  if (process.env.MEDIA_TOKEN_SECRET) {
    // Domain-separate using HMAC so the derived key cannot be used for streams
    return createHmac('sha256', process.env.MEDIA_TOKEN_SECRET)
      .update('playback_refresh')
      .digest('hex')
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'TRUSTED_HOME_PLAYBACK_REFRESH_SECRET (or MEDIA_TOKEN_SECRET) must be set in production. ' +
      'Generate a strong secret and set TRUSTED_HOME_PLAYBACK_REFRESH_SECRET.'
    )
  }
  // Development fallback — random per-process key (tokens do not survive restarts)
  return randomBytes(32).toString('hex')
}

// ─── Per-user viewer identity secret ──────────────────────────────────────────

/**
 * Resolve the HMAC-SHA256 secret used to derive opaque per-user viewer identity
 * hashes for federated progress sync. The secret lives ONLY on the viewer Home;
 * the source Home never computes it.
 *
 * Resolution order:
 *   1. TRUSTED_HOME_VIEWER_IDENTITY_SECRET — explicit, recommended.
 *   2. MEDIA_TOKEN_SECRET present — derive a domain-separated key via
 *      HMAC(MEDIA_TOKEN_SECRET, "viewer_identity_v1"). Stable across restarts.
 *   3. Development only — a deterministic per-process dev key. Deliberately NOT
 *      random: a random dev secret silently breaks per-user resume across restarts
 *      and orphans rows on the source. Production without any secret throws.
 *
 * Returns a hex string safe for use as an HMAC key. NEVER logged or exposed.
 */
const DEV_VIEWER_IDENTITY_SECRET = createHmac('sha256', 'helix-dev-viewer-identity-v1')
  .update('viewer_identity_v1')
  .digest('hex')

export function resolveViewerIdentitySecret(): string {
  if (process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET) {
    return process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET
  }
  if (process.env.MEDIA_TOKEN_SECRET) {
    return createHmac('sha256', process.env.MEDIA_TOKEN_SECRET)
      .update('viewer_identity_v1')
      .digest('hex')
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'TRUSTED_HOME_VIEWER_IDENTITY_SECRET (or MEDIA_TOKEN_SECRET) must be set in production ' +
      'to use per-user federated progress identity. Set TRUSTED_HOME_VIEWER_IDENTITY_SECRET.'
    )
  }
  // Development fallback — deterministic (NOT random) so per-user resume survives restarts.
  return DEV_VIEWER_IDENTITY_SECRET
}

/**
 * Resolve the PREVIOUS viewer identity secret for rotation continuity, or null.
 *
 * Explicit-only: TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET. There is no
 * MEDIA_TOKEN_SECRET-derived previous key — the previous secret is purely an
 * operator-supplied rotation aid that should be removed after the rotation
 * window. NEVER logged, audited, exposed, or placed in a URL.
 */
export function resolveViewerIdentityPreviousSecret(): string | null {
  return process.env.TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET || null
}

/** Whether a previous viewer identity secret is configured (state label only — never the value). */
export function isViewerIdentityPreviousSecretConfigured(): boolean {
  return Boolean(process.env.TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET)
}

/**
 * Resolution state of the viewer identity signing key. Mirrors RefreshSecretHealth.
 * NEVER returns the secret value, hash, or env var contents — only the state label.
 *   dev_random here means "development deterministic fallback" (non-production).
 */
export function getViewerIdentitySecretHealth(): RefreshSecretHealth {
  if (process.env.TRUSTED_HOME_VIEWER_IDENTITY_SECRET) {
    return 'explicit_secret'
  }
  if (process.env.MEDIA_TOKEN_SECRET) {
    return 'derived_fallback'
  }
  if (process.env.NODE_ENV === 'production') {
    return 'missing'
  }
  return 'dev_random'
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? './data/helix.db',
  dataDir: process.env.DATA_DIR ?? './data',
  nodeEnv: process.env.NODE_ENV ?? 'development',

  // TMDB credentials — both optional; app runs without them
  tmdbApiKey: process.env.TMDB_API_KEY ?? null,
  tmdbReadAccessToken: process.env.TMDB_READ_ACCESS_TOKEN ?? null,

  // Metadata caching
  metadataCacheDir: process.env.METADATA_CACHE_DIR ?? join(process.env.DATA_DIR ?? './data', 'metadata_cache'),

  // Feature flags
  metadataEnrichmentEnabled: (process.env.METADATA_ENRICHMENT_ENABLED ?? 'true') !== 'false',

  // Enrichment queue recovery / scheduling
  enrichmentJobStaleAfterMs: Number(process.env.ENRICHMENT_JOB_STALE_AFTER_MS ?? 600000),
  enrichmentPeriodicEnabled: (process.env.ENRICHMENT_PERIODIC_ENABLED ?? 'true') !== 'false',
  enrichmentPeriodicIntervalMs: Number(process.env.ENRICHMENT_PERIODIC_INTERVAL_MS ?? 21600000),

  // Trusted Home background auto-sync
  trustedHomeSyncEnabled: (process.env.TRUSTED_HOME_SYNC_ENABLED ?? 'true') !== 'false',
  trustedHomeSyncIntervalMs: Number(process.env.TRUSTED_HOME_SYNC_INTERVAL_MS ?? 21600000),
  trustedHomeSyncStaggerMs: Number(process.env.TRUSTED_HOME_SYNC_STAGGER_MS ?? 30000),
  trustedHomeSyncOnStartup: (process.env.TRUSTED_HOME_SYNC_ON_STARTUP ?? 'false') === 'true',

  // Tombstone retention
  tombstoneRetentionDays: Math.max(1, Number(process.env.TOMBSTONE_RETENTION_DAYS ?? 90)),

  // Audit event retention
  // Valid range: 1–3650 days. Invalid or out-of-range values are clamped to bounds.
  // Default: 90 days. Set TRUSTED_HOME_AUDIT_RETENTION_DAYS to override.
  auditRetentionDays: (() => {
    const raw = Number(process.env.TRUSTED_HOME_AUDIT_RETENTION_DAYS ?? 90)
    const n = isFinite(raw) && !isNaN(raw) ? raw : 90
    return Math.min(3650, Math.max(1, Math.round(n)))
  })(),

  // Public base URL — validated and normalized; null if not set
  baseUrl: configuredBaseUrl,

  // Trusted Home playback proxy
  trustedHomePlaybackProxyEnabled: (process.env.TRUSTED_HOME_PLAYBACK_PROXY_ENABLED ?? 'true') !== 'false',
  trustedHomeProxyRequestTimeoutMs: Number(process.env.TRUSTED_HOME_PROXY_REQUEST_TIMEOUT_MS ?? 30000),

  // Federated progress outbox worker
  progressOutboxWorkerIntervalMs: Number(process.env.PROGRESS_OUTBOX_WORKER_INTERVAL_MS ?? 30000),
  progressOutboxMaxAttempts: Math.max(1, Number(process.env.PROGRESS_OUTBOX_MAX_ATTEMPTS ?? 3)),

  // Signed playback refresh tokens
  //
  // trustedHomePlaybackRefreshSecret — HMAC-SHA256 key used to sign and verify the
  //   short-lived refresh tokens embedded in PlaybackSource.refreshUrl.
  //   Resolution order:
  //     1. TRUSTED_HOME_PLAYBACK_REFRESH_SECRET (dedicated env var — recommended)
  //     2. Derived from MEDIA_TOKEN_SECRET via HMAC(secret, "playback_refresh") —
  //        domain-separated so the same root secret cannot be used directly.
  //     3. In development only: a random per-process secret is generated.
  //        In production (NODE_ENV=production) without an explicit secret this
  //        throws at startup to prevent accidental insecurity.
  //
  // trustedHomePlaybackRefreshTokenTtlMs — lifetime of each refresh token (ms).
  //   Default 3 minutes. Clients should call the refresh endpoint before this
  //   expires; they receive a new token (rotated nonce/iat/exp) on every refresh.
  //   Reduced from 10 min to 3 min for tighter token-expiry windows.
  trustedHomePlaybackRefreshTokenTtlMs: Number(
    process.env.TRUSTED_HOME_PLAYBACK_REFRESH_TOKEN_TTL_MS ?? 180000
  ),
}
