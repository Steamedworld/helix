import { existsSync } from 'fs'
import { eq } from 'drizzle-orm'
import type { DrizzleDB } from '../../db/client'
import { mediaFiles, mediaVersions, nodes, mediaItems } from '../../db/schema'
import { signStreamToken } from '../../lib/signedTokens'
import type { NodeCapabilities } from './capabilities'

// ─── Discriminator codes ──────────────────────────────────────────────────────

export type PlaybackCode =
  | 'local_playable'
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
}

export interface PlaybackSourceResult {
  source: PlaybackSource
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
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function getPlaybackSource(
  mediaItemId: string,
  db: DrizzleDB,
  localNodeId: string,
  baseUrl: string | null,
  userId?: string
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
        .select({ id: nodes.id, name: nodes.name, capabilities_json: nodes.capabilities_json })
        .from(nodes)
        .where(eq(nodes.id, remoteNodeId))

      const remoteNodeName = remoteNode?.name ?? 'a remote node'
      const capabilities: NodeCapabilities | null = remoteNode?.capabilities_json
        ? (() => { try { return JSON.parse(remoteNode.capabilities_json) as NodeCapabilities } catch { return null } })()
        : null

      // If capabilities say remote playback is supported, mark remote_available;
      // otherwise (unknown or explicitly false) treat as remote_playback_unsupported.
      const supportsPlayback = capabilities?.supportsRemotePlayback === true
      const code: PlaybackCode = supportsPlayback ? 'remote_available' : 'remote_playback_unsupported'
      const reason = `Available on ${remoteNodeName}. Remote playback is not enabled yet.`

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
