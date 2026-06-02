import { existsSync } from 'fs'
import { eq } from 'drizzle-orm'
import type { DrizzleDB } from '../../db/client'
import { mediaFiles, mediaVersions, nodes, mediaItems } from '../../db/schema'
import { signStreamToken } from '../../lib/signedTokens'
import type { NodeCapabilities } from './capabilities'
import { decryptApiKey } from '../integrations/encryption'
import { isLoopbackUrl, isPrivateUrl, config, resolvePlaybackRefreshSecret } from '../../config'
import { signPlaybackRefreshToken } from './playbackRefreshToken'

// ─── Refresh metadata helpers ─────────────────────────────────────────────────

const MEDIA_TOKEN_TTL_SECONDS = Number(process.env.MEDIA_TOKEN_TTL_SECONDS ?? 14400)

/**
 * Compute refreshAfter: 75% of TTL consumed (conservative).
 * For very short TTLs (< 120s), use 50% instead.
 */
function computeRefreshAfter(issuedAt: Date, ttlSeconds: number): string {
  const fraction = ttlSeconds < 120 ? 0.5 : 0.75
  return new Date(issuedAt.getTime() + ttlSeconds * fraction * 1000).toISOString()
}

// ─── Discriminator codes ──────────────────────────────────────────────────────

export type PlaybackCode =
  | 'local_playable'
  | 'remote_direct'
  | 'remote_available'
  | 'remote_playback_unsupported'
  | 'unavailable'

// ─── Playable result ──────────────────────────────────────────────────────────

export interface PlaybackSource {
  code: 'local_playable'
  nodeId: string
  nodeBaseUrl: string | null
  nodeKind: 'local'
  nodeName: string
  mediaItemId: string
  selectedVersionId: string
  selectedFileId: string
  fileId: string        // alias of selectedFileId for backwards compat
  versionId: string     // alias of selectedVersionId for backwards compat
  filePath: string
  filename: string
  container: string | null
  quality_label: string | null
  resolution_width: number | null
  resolution_height: number | null
  video_codec: string | null
  audio_codec: string | null
  streamUrl: string
  score: number
  expiresAt: string         // ISO — when the signed stream URL expires
  refreshAfter: string      // ISO — when client should proactively refresh (75% of TTL)
  tokenTtlSeconds: number   // total TTL of the signed token, for client reference
}

export interface RemoteDirectPlaybackSource {
  code: 'remote_direct'
  sourceType: 'remote_direct'
  nodeId: string
  nodeName: string
  streamUrl: string
  expiresAt: string         // ISO — when the signed stream URL expires (from remote node)
  refreshAfter: string      // ISO — when client should proactively refresh (75% of TTL)
  tokenTtlSeconds: number   // total TTL of the signed token, for client reference
  mediaFileId: string
  contentType: string | null
  container: string | null
  /**
   * Proxy stream URL — available when proxy is enabled.
   * The browser calls the local Helix server which relays the stream server-to-server.
   * The Trusted Home token never reaches the browser.
   */
  proxyStreamUrl?: string
  /**
   * Endpoint to call to get a fresh PlaybackSource when the proxy URL may be expiring.
   * Only present when proxyStreamUrl is set.
   *
   * Contains a short-lived HMAC-SHA256 signed token (?rt=...) scoped to the user,
   * session, node, and media item. The token is time-limited and tamper-resistant.
   * The frontend treats this URL as opaque — it must not parse or modify the ?rt param.
   */
  refreshUrl?: string
  /**
   * Direct stream URL from the remote node — only included when node.base_url is NOT a
   * private/loopback address (best-effort heuristic). User must explicitly choose to switch.
   */
  directStreamUrl?: string
  /** Informational warning — does not block playback. Present when the stream URL
   *  points to a loopback address that remote browsers may not be able to reach. */
  warning?: string
}

export interface PlaybackSourceResult {
  source: PlaybackSource | RemoteDirectPlaybackSource
  unavailable?: never
}

// ─── Unavailable result ───────────────────────────────────────────────────────

export interface PlaybackSourceUnavailable {
  source?: never
  unavailable: true
  code: PlaybackCode
  reason: string
  nodeId: string | null
  nodeName: string | null
  nodeKind: 'local' | 'remote' | null
  remoteCapabilities?: NodeCapabilities | null
}

export type PlaybackSourceOrUnavailable = PlaybackSourceResult | PlaybackSourceUnavailable

// ─── Resolution scoring ───────────────────────────────────────────────────────

function resolutionScore(width: number | null, height: number | null): number {
  if (!width || !height) return 1000
  const px = width * height
  if (px >= 3840 * 2160) return 10   // 4K
  if (px >= 1920 * 1080) return 20   // 1080p
  if (px >= 1280 * 720) return 30    // 720p
  if (px >= 854 * 480) return 40     // 480p
  return 50
}

// ─── Legacy stub ──────────────────────────────────────────────────────────────

export async function selectBestSource(
  mediaItemId: string,
  userId: string,
  db?: DrizzleDB,
  localNodeId?: string,
  baseUrl?: string | null
): Promise<PlaybackSource | null> {
  if (!db || !localNodeId) return null
  return selectBestLocalSource(mediaItemId, db, localNodeId, baseUrl ?? null, userId, 'Helix Local')
}

// ─── Local source selection ───────────────────────────────────────────────────

export async function selectBestLocalSource(
  mediaItemId: string,
  db: DrizzleDB,
  localNodeId: string,
  baseUrl: string | null,
  userId?: string,
  nodeName?: string
): Promise<PlaybackSource | null> {
  const rows = await db
    .select({ file: mediaFiles, version: mediaVersions })
    .from(mediaFiles)
    .innerJoin(mediaVersions, eq(mediaFiles.media_version_id, mediaVersions.id))
    .where(eq(mediaFiles.media_item_id, mediaItemId))

  if (rows.length === 0) return null

  const localRows = rows.filter(
    (r) =>
      r.file.node_id === localNodeId &&
      r.file.missing_at === null &&
      existsSync(r.file.path)
  )

  if (localRows.length === 0) return null

  const scored = localRows.map((r) => ({
    ...r,
    score: resolutionScore(r.version.resolution_width, r.version.resolution_height),
  }))
  scored.sort((a, b) => a.score - b.score)

  const best = scored[0]
  const nodeBaseUrl = baseUrl ?? 'http://localhost:3001'
  const basePath = `${nodeBaseUrl}/api/v1/media-files/${best.file.id}/stream`
  const streamUrl = userId
    ? `${basePath}?token=${signStreamToken(best.file.id, userId)}`
    : basePath

  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + MEDIA_TOKEN_TTL_SECONDS * 1000).toISOString()
  const refreshAfter = computeRefreshAfter(issuedAt, MEDIA_TOKEN_TTL_SECONDS)

  return {
    code: 'local_playable',
    nodeId: localNodeId,
    nodeBaseUrl: baseUrl,
    nodeKind: 'local',
    nodeName: nodeName ?? 'Helix Local',
    mediaItemId,
    selectedVersionId: best.version.id,
    selectedFileId: best.file.id,
    fileId: best.file.id,
    versionId: best.version.id,
    filePath: best.file.path,
    filename: best.file.filename,
    container: best.version.container,
    quality_label: best.version.quality_label,
    resolution_width: best.version.resolution_width,
    resolution_height: best.version.resolution_height,
    video_codec: best.version.video_codec,
    audio_codec: best.version.audio_codec,
    streamUrl,
    score: best.score,
    expiresAt,
    refreshAfter,
    tokenTtlSeconds: MEDIA_TOKEN_TTL_SECONDS,
  }
}

// ─── Remote direct playback intent ───────────────────────────────────────────

interface PlaybackIntentResponse {
  status: 'ready' | 'unavailable' | 'unsupported'
  mode?: string
  streamUrl?: string
  expiresAt?: string
  mediaFileId?: string
  contentType?: string | null
  container?: string | null
  reason?: string
}

async function fetchRemotePlaybackIntent(
  baseUrl: string,
  rawToken: string,
  mediaItemId: string
): Promise<PlaybackIntentResponse | null> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/federation/playback-intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rawToken}`,
      },
      body: JSON.stringify({ mediaItemId, requestedMode: 'direct' }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    const json = await res.json() as { ok: boolean; data: PlaybackIntentResponse }
    if (!json.ok) return null
    return json.data
  } catch {
    return null
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function getPlaybackSource(
  mediaItemId: string,
  db: DrizzleDB,
  localNodeId: string,
  baseUrl: string | null,
  userId?: string,
  dataDir?: string,
  /** Session binding hash (SHA-256(rawToken)[0..31]) for signing refreshUrl tokens. */
  sessionBinding?: string
): Promise<PlaybackSourceOrUnavailable> {
  const [item] = await db
    .select({ kind: mediaItems.kind })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId))

  if (item) {
    if (item.kind === 'show') {
      return {
        unavailable: true,
        code: 'unavailable',
        reason: 'Cannot play a show container — select a specific episode.',
        nodeId: null,
        nodeName: null,
        nodeKind: null,
      }
    }
    if (item.kind === 'season') {
      return {
        unavailable: true,
        code: 'unavailable',
        reason: 'Cannot play a season container — select a specific episode.',
        nodeId: null,
        nodeName: null,
        nodeKind: null,
      }
    }
  }

  const allFiles = await db
    .select({
      id: mediaFiles.id,
      node_id: mediaFiles.node_id,
      path: mediaFiles.path,
      missing_at: mediaFiles.missing_at,
    })
    .from(mediaFiles)
    .where(eq(mediaFiles.media_item_id, mediaItemId))

  if (allFiles.length === 0) {
    return {
      unavailable: true,
      code: 'unavailable',
      reason: 'No files found for this media item',
      nodeId: null,
      nodeName: null,
      nodeKind: null,
    }
  }

  const localFiles = allFiles.filter((f) => f.node_id === localNodeId)

  if (localFiles.length === 0) {
    const remoteFiles = allFiles.filter((f) => f.node_id !== localNodeId)
    if (remoteFiles.length > 0) {
      // Look up the remote node name and capabilities
      const remoteNodeId = remoteFiles[0].node_id
      const [remoteNode] = await db
        .select({
          id: nodes.id,
          name: nodes.name,
          base_url: nodes.base_url,
          api_token_encrypted: nodes.api_token_encrypted,
          capabilities_json: nodes.capabilities_json,
        })
        .from(nodes)
        .where(eq(nodes.id, remoteNodeId))

      const remoteNodeName = remoteNode?.name ?? 'a remote node'
      const capabilities: NodeCapabilities | null = remoteNode?.capabilities_json
        ? (() => { try { return JSON.parse(remoteNode.capabilities_json) as NodeCapabilities } catch { return null } })()
        : null

      // Attempt remote direct playback if node supports it and we have a token + dataDir
      if (
        capabilities?.supportsRemotePlayback === true &&
        capabilities?.supportsSignedPlaybackUrls === true &&
        remoteNode?.base_url &&
        remoteNode?.api_token_encrypted &&
        dataDir
      ) {
        try {
          const rawToken = decryptApiKey(remoteNode.api_token_encrypted, dataDir)
          const intentResult = await fetchRemotePlaybackIntent(remoteNode.base_url, rawToken, mediaItemId)

          if (intentResult?.status === 'ready' && intentResult.streamUrl && intentResult.expiresAt && intentResult.mediaFileId) {
            // Warn if the stream URL returned by the remote node is a loopback address —
            // this means the remote node did not configure BASE_URL and direct playback
            // will only work if the browser is on the same machine as the remote node.
            let streamWarning: string | undefined
            if (isLoopbackUrl(intentResult.streamUrl)) {
              streamWarning =
                `Remote node stream URL points to localhost. Direct playback will only work ` +
                `if your browser is on the same machine as the remote node (${remoteNodeName}).`
            }

            // Compute refresh metadata from the remote node's expiresAt
            const remoteNow = new Date()
            const remoteExpiry = new Date(intentResult.expiresAt)
            const remoteTtlSeconds = Math.max(0, Math.floor((remoteExpiry.getTime() - remoteNow.getTime()) / 1000))
            const remoteRefreshAfter = computeRefreshAfter(remoteNow, remoteTtlSeconds)

            // Build proxy stream URL — browser calls local server which relays server-to-server.
            // The remote federation token never reaches the browser in this mode.
            const proxyStreamUrl = config.trustedHomePlaybackProxyEnabled
              ? `/api/v1/nodes/${remoteNodeId}/media/${mediaItemId}/stream`
              : undefined

            // Refresh URL — endpoint for the player to get a fresh PlaybackSource.
            // When userId and sessionBinding are available, embed a short-lived signed
            // token (?rt=...) so the endpoint can authenticate without a session cookie.
            // The token is scoped to this user, session, node, and media item.
            let refreshUrl: string | undefined
            if (proxyStreamUrl) {
              const baseRefreshPath = `/api/v1/nodes/${remoteNodeId}/media/${mediaItemId}/playback-source`
              if (userId && sessionBinding) {
                try {
                  const signingSecret = resolvePlaybackRefreshSecret()
                  const rtToken = signPlaybackRefreshToken(
                    { sub: userId, sid: sessionBinding, nodeId: remoteNodeId, mediaId: mediaItemId },
                    signingSecret,
                    config.trustedHomePlaybackRefreshTokenTtlMs
                  )
                  refreshUrl = `${baseRefreshPath}?rt=${rtToken}`
                } catch {
                  // If signing fails (e.g. misconfigured secret), fall back to plain URL
                  refreshUrl = baseRefreshPath
                }
              } else {
                // No session binding available — plain URL (session cookie required at refresh time)
                refreshUrl = baseRefreshPath
              }
            }

            // Fallback direct URL — only expose if node.base_url is NOT a private/loopback
            // address. This is a best-effort heuristic: if the remote node is on a private IP,
            // the browser on a different network cannot reach it directly.
            // Auto-fallback is intentionally NOT implemented — user must choose to switch.
            let fallbackDirectUrl: string | undefined
            let fallbackWarning: string | undefined
            if (proxyStreamUrl && remoteNode.base_url && !isPrivateUrl(remoteNode.base_url)) {
              fallbackDirectUrl = intentResult.streamUrl
            } else if (proxyStreamUrl && remoteNode.base_url && isPrivateUrl(remoteNode.base_url)) {
              fallbackWarning =
                `Remote Home address appears to be on a private network — ` +
                `browser may not be able to reach it directly.`
            }

            // For the primary streamUrl, prefer proxy when available
            const primaryStreamUrl = proxyStreamUrl ?? intentResult.streamUrl

            return {
              source: {
                code: 'remote_direct',
                sourceType: 'remote_direct',
                nodeId: remoteNodeId,
                nodeName: remoteNodeName,
                streamUrl: primaryStreamUrl,
                expiresAt: intentResult.expiresAt,
                refreshAfter: remoteRefreshAfter,
                tokenTtlSeconds: remoteTtlSeconds,
                mediaFileId: intentResult.mediaFileId,
                contentType: intentResult.contentType ?? null,
                container: intentResult.container ?? null,
                ...(proxyStreamUrl ? { proxyStreamUrl } : {}),
                ...(refreshUrl ? { refreshUrl } : {}),
                ...(fallbackDirectUrl ? { directStreamUrl: fallbackDirectUrl } : {}),
                ...(streamWarning ? { warning: streamWarning }
                  : fallbackWarning ? { warning: fallbackWarning }
                  : {}),
              },
            }
          }

          // Remote responded but file unavailable
          if (intentResult?.status === 'unavailable') {
            return {
              unavailable: true,
              code: 'unavailable',
              reason: `File is unavailable on ${remoteNodeName}.`,
              nodeId: remoteNodeId,
              nodeName: remoteNodeName,
              nodeKind: 'remote',
              remoteCapabilities: capabilities,
            }
          }
        } catch {
          // Remote fetch failed — fall through to unsupported response
        }
      }

      // If capabilities say remote playback is supported, mark remote_available;
      // otherwise (unknown or explicitly false) treat as remote_playback_unsupported.
      const supportsPlayback = capabilities?.supportsRemotePlayback === true
      const code: PlaybackCode = supportsPlayback ? 'remote_available' : 'remote_playback_unsupported'
      const reason = supportsPlayback
        ? `Remote playback from ${remoteNodeName} is temporarily unavailable.`
        : `Available on ${remoteNodeName}. Remote playback is not supported by this node.`

      return {
        unavailable: true,
        code,
        reason,
        nodeId: remoteNodeId,
        nodeName: remoteNodeName,
        nodeKind: 'remote',
        remoteCapabilities: capabilities,
      }
    }
    return {
      unavailable: true,
      code: 'unavailable',
      reason: 'No files available on the local node',
      nodeId: null,
      nodeName: null,
      nodeKind: null,
    }
  }

  const missingFiles = localFiles.filter((f) => f.missing_at !== null)
  if (missingFiles.length === localFiles.length) {
    return {
      unavailable: true,
      code: 'unavailable',
      reason: 'All files for this item were present but have gone missing — library may need re-scan',
      nodeId: localNodeId,
      nodeName: null,
      nodeKind: 'local',
    }
  }

  const existingFiles = localFiles.filter((f) => f.missing_at === null && existsSync(f.path))
  if (existingFiles.length === 0) {
    return {
      unavailable: true,
      code: 'unavailable',
      reason: 'File(s) found in catalog but not on disk — library may need re-scan',
      nodeId: localNodeId,
      nodeName: null,
      nodeKind: 'local',
    }
  }

  // Look up the local node name
  const [localNode] = await db
    .select({ name: nodes.name })
    .from(nodes)
    .where(eq(nodes.id, localNodeId))

  const source = await selectBestLocalSource(
    mediaItemId,
    db,
    localNodeId,
    baseUrl,
    userId,
    localNode?.name ?? 'Helix Local'
  )

  if (!source) {
    return {
      unavailable: true,
      code: 'unavailable',
      reason: 'Source selection failed unexpectedly',
      nodeId: null,
      nodeName: null,
      nodeKind: null,
    }
  }

  return { source }
}
