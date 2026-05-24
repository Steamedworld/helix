import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from './config'
import { healthRoutes } from './routes/health'
import { libraryRoutes } from './routes/libraries'
import { mediaRoutes } from './routes/media'
import { artworkRoutes } from './routes/artwork'
import { nodeRoutes } from './routes/nodes'
import { watchStateRoutes } from './routes/watchstate'
import { streamRoutes } from './routes/stream'
import { playbackRoutes } from './routes/playback'
import { metadataCollectionRoutes, metadataItemRoutes } from './routes/metadata'
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

export function buildServer(db: DrizzleDB, localNodeId: string, baseUrl?: string | null) {
  setupMetadataProviders()

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

  // Routes
  app.register(healthRoutes, { prefix: '/api/v1' })
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
  } as Parameters<typeof nodeRoutes>[1] & { prefix: string })
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

  // Global error handler
  app.setErrorHandler((error, _req, reply) => {
    reply.status(error.statusCode ?? 500).send(err(error.message, error.validation))
  })

  return app
}
