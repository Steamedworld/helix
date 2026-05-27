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
}

export function makeLocalCapabilities(nodeId: string, nodeName: string): NodeCapabilities {
  return {
    nodeId,
    nodeName,
    version: '0.1.0',
    federationProtocolVersion: '1',
    supportsCatalogSync: true,
    supportsArtworkProxy: true,
    supportsRemotePlayback: false,
    supportedPlaybackModes: [],
    supportsSignedPlaybackUrls: false,
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
