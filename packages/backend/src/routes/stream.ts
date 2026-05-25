import type { FastifyInstance, FastifyReply } from 'fastify'
import { createReadStream, statSync } from 'fs'
import { existsSync } from 'fs'
import { eq } from 'drizzle-orm'
import { mediaFiles, mediaItems } from '../db/schema'
import { err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { verifyStreamToken } from '../lib/signedTokens'
import { getCurrentUser } from '../middleware/auth'
import { canPlayLibrary, getLibraryIdForMediaItem } from '../lib/permissions'

const MIME_MAP: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

interface RangeResult {
  start: number
  end: number
}

function parseRange(
  rangeHeader: string,
  fileSize: number
): RangeResult | null {
  // Range: bytes=start-end  or  bytes=-suffix
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null

  const rawStart = match[1]
  const rawEnd = match[2]

  if (rawStart === '' && rawEnd === '') return null

  let start: number
  let end: number

  if (rawStart === '') {
    // suffix-length: bytes=-500 means last 500 bytes
    const suffix = parseInt(rawEnd, 10)
    if (suffix <= 0 || isNaN(suffix)) return null
    start = Math.max(0, fileSize - suffix)
    end = fileSize - 1
  } else {
    start = parseInt(rawStart, 10)
    end = rawEnd !== '' ? parseInt(rawEnd, 10) : fileSize - 1
  }

  if (isNaN(start) || isNaN(end)) return null
  if (start > end) return null
  if (start >= fileSize) return null

  // Clamp end to fileSize - 1
  end = Math.min(end, fileSize - 1)

  return { start, end }
}

function sendError(reply: FastifyReply, status: number, message: string) {
  reply.header('Content-Type', 'application/json')
  return reply.status(status).send(JSON.stringify(err(message)))
}

export async function streamRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId: string }
) {
  const { db, localNodeId } = opts

  // GET /media-files/:id/stream
  // Access: valid signed token (query ?token=) OR valid session cookie with canPlay
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/media-files/:id/stream',
    async (req, reply) => {
      const fileId = req.params.id
      const token = req.query.token

      let authorizedUserId: string | null = null

      if (token) {
        const verified = verifyStreamToken(token)
        if (!verified) {
          return sendError(reply, 401, 'Invalid or expired stream token')
        }
        if (verified.fileId !== fileId) {
          return sendError(reply, 403, 'Token does not match requested file')
        }
        authorizedUserId = verified.userId
      } else {
        // Fall back to session cookie auth
        const authResult = await getCurrentUser(req, db)
        if (!authResult) {
          return sendError(reply, 401, 'Authentication required')
        }
        const user = authResult.user
        // Look up the library for this file to check canPlay
        const [file] = await db
          .select({ library_id: mediaFiles.library_id })
          .from(mediaFiles)
          .where(eq(mediaFiles.id, fileId))
        if (!file) {
          return sendError(reply, 404, 'Media file not found')
        }
        const allowed = await canPlayLibrary(user, file.library_id, db)
        if (!allowed) {
          return sendError(reply, 403, 'Playback not permitted for this library')
        }
        authorizedUserId = user.id
      }

      // Look up file
      const [file] = await db
        .select()
        .from(mediaFiles)
        .where(eq(mediaFiles.id, fileId))

      if (!file) {
        return sendError(reply, 404, 'Media file not found')
      }

      // Confirm belongs to local node
      if (file.node_id !== localNodeId) {
        return sendError(reply, 403, 'File is not on the local node')
      }

      // Confirm file exists on disk
      if (!existsSync(file.path)) {
        return sendError(reply, 404, 'File not found on disk')
      }

      // Get file size
      let fileSize: number
      try {
        const stat = statSync(file.path)
        fileSize = stat.size
      } catch {
        return sendError(reply, 500, 'Failed to stat file')
      }

      const mimeType = MIME_MAP[file.extension.toLowerCase()] ?? 'application/octet-stream'
      const rangeHeader = req.headers.range

      reply.header('Accept-Ranges', 'bytes')
      reply.header('Content-Type', mimeType)

      if (rangeHeader) {
        const range = parseRange(rangeHeader, fileSize)

        if (!range) {
          reply.header('Content-Range', `bytes */${fileSize}`)
          return sendError(reply, 416, 'Range not satisfiable')
        }

        const { start, end } = range
        const chunkSize = end - start + 1

        reply.status(206)
        reply.header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
        reply.header('Content-Length', String(chunkSize))

        const stream = createReadStream(file.path, { start, end })
        return reply.send(stream)
      }

      // Full file
      reply.status(200)
      reply.header('Content-Length', String(fileSize))
      const stream = createReadStream(file.path)
      return reply.send(stream)
    }
  )
}
