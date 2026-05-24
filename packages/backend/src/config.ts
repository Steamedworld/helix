import { join } from 'path'

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
}
