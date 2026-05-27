import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import { config } from './config'
import { healthRoutes } from './routes/health'
import { libraryRoutes } from './routes/libraries'
import { mediaRoutes } from './routes/media'
import { artworkRoutes } from './routes/artwork'
import { nodeRoutes } from './routes/nodes'
import { federationRoutes } from './routes/federation'
import { watchStateRoutes } from './routes/watchstate'
import { streamRoutes } from './routes/stream'
import { playbackRoutes } from './routes/playback'
import { metadataCollectionRoutes, metadataItemRoutes } from './routes/metadata'
import { tvRoutes, seasonRoutes, episodeRoutes } from './routes/tv'
import { authRoutes } from './routes/auth'
import { userRoutes } from './routes/users'
import { integrationRoutes } from './routes/integrations'
import { webhookRoutes } from './routes/webhooks'
import { enrichmentQueueRoutes } from './routes/enrichmentQueue'
import { enrichmentQueue } from './services/enrichmentQueue'
import { err } from './lib/response'
import type { DrizzleDB } from './db/client'
import { metadataRegistry } from './services/metadata/registry'
import { createTmdbProvider } from './services/metadata/providers/tmdb'

function setupMetadataProviders() {
  // Only register once — guard against double-call in tests
  if (!metadataRegistry.getProvider('tmdb')) {
    const tmdb = createTmdbProvider(config.tmdbReadAccessToken, config.tmdbApiKey)
    metadataRegistry.register(tmdb)
  }
}

export function buildServer(db: DrizzleDB, localNodeId: string, baseUrl?: string | null, dataDir?: string) {
  setupMetadataProviders()

  const resolvedDataDir = dataDir ?? './data'

  const app = Fastify({
    logger:
      config.nodeEnv === 'development'
        ? {
            level: 'info',
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname',
              },
            },
          }
        : { level: 'warn' },
  })

  // CORS — allow all in dev
  app.register(cors, {
    origin: true,
    credentials: true,
  })

  // Cookie support
  app.register(cookie)

  // Routes
  app.register(healthRoutes, { prefix: '/api/v1' })

  // Auth routes
  app.register(authRoutes, {
    prefix: '/api/v1/auth',
    db,
  } as Parameters<typeof authRoutes>[1] & { prefix: string })

  // User management routes (admin only)
  app.register(userRoutes, {
    prefix: '/api/v1/users',
    db,
  } as Parameters<typeof userRoutes>[1] & { prefix: string })
  app.register(libraryRoutes, {
    prefix: '/api/v1/libraries',
    db,
    localNodeId,
  } as Parameters<typeof libraryRoutes>[1] & { prefix: string })
  app.register(mediaRoutes, {
    prefix: '/api/v1/media',
    db,
    localNodeId,
    baseUrl: baseUrl ?? null,
  } as Parameters<typeof mediaRoutes>[1] & { prefix: string })
  app.register(artworkRoutes, {
    prefix: '/api/v1/media',
    db,
  } as Parameters<typeof artworkRoutes>[1] & { prefix: string })
  app.register(nodeRoutes, {
    prefix: '/api/v1/nodes',
    db,
    localNodeId,
    dataDir: resolvedDataDir,
  } as Parameters<typeof nodeRoutes>[1] & { prefix: string })
  app.register(federationRoutes, {
    prefix: '/api/v1/federation',
    db,
    localNodeId,
    dataDir: resolvedDataDir,
  } as Parameters<typeof federationRoutes>[1] & { prefix: string })
  app.register(watchStateRoutes, {
    prefix: '/api/v1/watchstate',
    db,
  } as Parameters<typeof watchStateRoutes>[1] & { prefix: string })
  app.register(streamRoutes, {
    prefix: '/api/v1',
    db,
    localNodeId,
  } as Parameters<typeof streamRoutes>[1] & { prefix: string })
  app.register(playbackRoutes, {
    prefix: '/api/v1/playback-sessions',
    db,
    localNodeId,
  } as Parameters<typeof playbackRoutes>[1] & { prefix: string })

  // Metadata — collection-level: /api/v1/metadata/...
  app.register(metadataCollectionRoutes, {
    prefix: '/api/v1/metadata',
    db,
  } as Parameters<typeof metadataCollectionRoutes>[1] & { prefix: string })

  // Metadata — per-item: /api/v1/media/:id/metadata/...
  app.register(metadataItemRoutes, {
    prefix: '/api/v1/media',
    db,
  } as Parameters<typeof metadataItemRoutes>[1] & { prefix: string })

  // Integration routes (Radarr, Sonarr, etc.)
  app.register(integrationRoutes, {
    prefix: '/api/v1/integrations',
    db,
    dataDir: resolvedDataDir,
  } as Parameters<typeof integrationRoutes>[1] & { prefix: string })

  // Webhook routes — no session auth, authenticated by token in path
  app.register(webhookRoutes, {
    prefix: '/api/v1/webhooks',
    db,
    dataDir: resolvedDataDir,
  } as Parameters<typeof webhookRoutes>[1] & { prefix: string })

  // Enrichment queue routes + background runner
  app.register(enrichmentQueueRoutes, {
    prefix: '/api/v1/enrichment-queue',
    db,
  } as Parameters<typeof enrichmentQueueRoutes>[1] & { prefix: string })

  app.addHook('onReady', async () => {
    enrichmentQueue.start(db)
  })

  app.addHook('onClose', async () => {
    enrichmentQueue.stop()
  })

  // TV hierarchy routes
  app.register(tvRoutes, {
    prefix: '/api/v1/shows',
    db,
    localNodeId,
    baseUrl: baseUrl ?? null,
  } as Parameters<typeof tvRoutes>[1] & { prefix: string })

  app.register(seasonRoutes, {
    prefix: '/api/v1/seasons',
    db,
    localNodeId,
    baseUrl: baseUrl ?? null,
  } as Parameters<typeof seasonRoutes>[1] & { prefix: string })

  app.register(episodeRoutes, {
    prefix: '/api/v1/episodes',
    db,
    localNodeId,
    baseUrl: baseUrl ?? null,
  } as Parameters<typeof episodeRoutes>[1] & { prefix: string })

  // Global error handler
  app.setErrorHandler((error, _req, reply) => {
    reply.status(error.statusCode ?? 500).send(err(error.message, error.validation))
  })

  return app
}
