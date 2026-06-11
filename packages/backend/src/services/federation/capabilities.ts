import { config, isLoopbackUrl } from '../../config'

export interface NodeCapabilities {
  nodeId: string
  nodeName: string
  version: string
  federationProtocolVersion: string
  supportsCatalogSync: boolean
  supportsArtworkProxy: boolean
  supportsRemotePlayback: boolean
  supportedPlaybackModes: string[]
  supportsSignedPlaybackUrls: boolean
  directPlaybackUrlTtlSeconds: number

  // BASE_URL diagnostics — added in phase 19
  // Tells remote hubs whether this node has a reachable public base URL configured.
  // Safe to expose: not a secret, just a deployment-state indicator.
  baseUrlConfigured: boolean
  publicBaseUrl?: string
  // Documentation flag: direct playback requires the browser to reach this node directly.
  directPlaybackRequiresBrowserReachability: true

  // Per-user progress identity (user_v1) — bilateral opt-in.
  // Informational only: security enforcement is the bilateral flag pair, not this field.
  // Optional: older peer Homes do not send it — absent means unsupported.
  supportsPerUserProgressIdentity?: boolean
}

export function makeLocalCapabilities(nodeId: string, nodeName: string): NodeCapabilities {
  // baseUrlConfigured is true only when BASE_URL is explicitly set AND is not a loopback address.
  const baseUrl = config.baseUrl ?? null
  const baseUrlConfigured = baseUrl !== null && !isLoopbackUrl(baseUrl)

  return {
    nodeId,
    nodeName,
    version: '0.1.0',
    federationProtocolVersion: '1',
    supportsCatalogSync: true,
    supportsArtworkProxy: true,
    supportsRemotePlayback: true,
    supportedPlaybackModes: ['direct'],
    supportsSignedPlaybackUrls: true,
    directPlaybackUrlTtlSeconds: Number(process.env.MEDIA_TOKEN_TTL_SECONDS ?? 14400),
    baseUrlConfigured,
    publicBaseUrl: baseUrl ?? undefined,
    directPlaybackRequiresBrowserReachability: true,
    supportsPerUserProgressIdentity: true,
  }
}

export async function fetchRemoteCapabilities(
  baseUrl: string,
  rawToken: string
): Promise<NodeCapabilities | null> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/federation/capabilities`, {
      headers: { Authorization: `Bearer ${rawToken}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const json = await res.json() as { ok: boolean; data: NodeCapabilities }
    if (!json.ok) return null
    return json.data
  } catch {
    return null
  }
}
