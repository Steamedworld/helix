import { join } from 'path'

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

  // Public base URL — validated and normalized; null if not set
  baseUrl: configuredBaseUrl,
}
