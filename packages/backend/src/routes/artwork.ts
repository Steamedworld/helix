import type { FastifyInstance } from 'fastify'
import { createReadStream, statSync } from 'fs'
import { existsSync } from 'fs'
import { extname, normalize, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { mediaItems, libraries } from '../db/schema'
import { err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { verifyArtworkToken } from '../lib/signedTokens'
import { getCurrentUser } from '../middleware/auth'
import { canViewLibrary } from '../lib/permissions'

type ArtworkKind = 'poster' | 'backdrop'

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
}

function isSafePathWithinRoots(filePath: string, libraryRoots: string[]): boolean {
  const resolved = resolve(normalize(filePath))
  return libraryRoots.some((root) => {
    const resolvedRoot = resolve(normalize(root))
    return resolved.startsWith(resolvedRoot + '/') || resolved.startsWith(resolvedRoot + '\\')
  })
}

export async function artworkRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB }
) {
  const { db } = opts

  // GET /media/:id/artwork/:kind
  // Access: valid signed artwork token (query ?token=) OR valid session cookie with canView
  app.get<{ Params: { id: string; kind: string }; Querystring: { token?: string } }>(
    '/:id/artwork/:kind',
    async (req, reply) => {
      const { id, kind } = req.params
      const token = req.query.token

      // Validate kind
      if (kind !== 'poster' && kind !== 'backdrop') {
        reply.status(400)
        return err('kind must be "poster" or "backdrop"')
      }

      const artworkKind = kind as ArtworkKind

      if (token) {
        const verified = verifyArtworkToken(token)
        if (!verified) {
          reply.status(401)
          return err('Invalid or expired artwork token')
        }
        if (verified.mediaItemId !== id || verified.kind !== artworkKind) {
          reply.status(403)
          return err('Token does not match requested artwork')
        }
      } else {
        // Fall back to session cookie auth
        const authResult = await getCurrentUser(req, db)
        if (!authResult) {
          reply.status(401)
          return err('Authentication required')
        }
        const user = authResult.user
        const [item] = await db
          .select({ library_id: mediaItems.library_id })
          .from(mediaItems)
          .where(eq(mediaItems.id, id))
        if (!item) {
          reply.status(404)
          return err('Media item not found')
        }
        const allowed = await canViewLibrary(user, item.library_id, db)
        if (!allowed) {
          reply.status(404)
          return err('Media item not found')
        }
      }

      // Look up media item
      const [item] = await db
        .select()
        .from(mediaItems)
        .where(eq(mediaItems.id, id))

      if (!item) {
        reply.status(404)
        return err('Media item not found')
      }

      const artworkPath =
        artworkKind === 'poster' ? item.poster_path : item.backdrop_path

      if (!artworkPath) {
        reply.status(404)
        return err(`No ${artworkKind} artwork for this item`)
      }

      // Validate path is within a known library root (path traversal prevention)
      const allLibraries = await db
        .select({ root_path: libraries.root_path })
        .from(libraries)

      const libraryRoots = allLibraries.map((l) => l.root_path)

      if (!isSafePathWithinRoots(artworkPath, libraryRoots)) {
        reply.status(403)
        return err('Artwork path is outside all known library roots')
      }

      // Check file exists on disk
      if (!existsSync(artworkPath)) {
        reply.status(404)
        return err('Artwork file not found on disk')
      }

      // Get file size for Content-Length
      let fileSize: number
      try {
        const stat = statSync(artworkPath)
        fileSize = stat.size
      } catch {
        reply.status(500)
        return err('Failed to stat artwork file')
      }

      const ext = extname(artworkPath).toLowerCase()
      const mimeType = EXT_MIME[ext] ?? 'application/octet-stream'

      reply.header('Content-Type', mimeType)
      reply.header('Content-Length', String(fileSize))
      reply.header('Cache-Control', 'public, max-age=86400')

      const stream = createReadStream(artworkPath)
      return reply.send(stream)
    }
  )
}
