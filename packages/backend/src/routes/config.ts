import type { FastifyInstance } from 'fastify'
import { ok } from '../lib/response'
import { config, isLoopbackUrl } from '../config'

/**
 * GET /api/v1/config — returns non-secret server configuration state.
 * No auth required — this is diagnostic information for the frontend.
 * IMPORTANT: this endpoint must never expose secrets, tokens, or internal paths.
 */
export async function configRoutes(app: FastifyInstance) {
  app.get('/config', async () => {
    const baseUrl = config.baseUrl ?? null
    const baseUrlConfigured = baseUrl !== null && !isLoopbackUrl(baseUrl)
    const baseUrlIsLoopback = baseUrl !== null && isLoopbackUrl(baseUrl)

    return ok({
      baseUrl,
      baseUrlConfigured,
      baseUrlIsLoopback,
    })
  })
}
