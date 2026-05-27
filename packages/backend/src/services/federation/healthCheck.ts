import type { Node, NodeStatus } from '@helix/shared'

// Legacy stub kept for existing tests
export async function checkNodeHealth(node: Node): Promise<NodeStatus> {
  if (node.kind === 'local') return 'online'
  return 'unknown'
}

// Real HTTP health check for remote nodes
export async function checkRemoteHealth(
  baseUrl: string,
  rawToken: string
): Promise<{ online: boolean; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/federation/health`, {
      headers: { Authorization: `Bearer ${rawToken}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return { online: false, error: `HTTP ${res.status}` }
    return { online: true }
  } catch (e) {
    return { online: false, error: e instanceof Error ? e.message : 'Connection failed' }
  }
}
