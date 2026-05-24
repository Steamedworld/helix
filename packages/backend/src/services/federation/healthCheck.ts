import type { Node, NodeStatus } from '@helix/shared'

export async function checkNodeHealth(node: Node): Promise<NodeStatus> {
  // TODO: multi-node federation — HTTP health check to remote node
  // For now: local node is always 'online'
  if (node.kind === 'local') return 'online'
  return 'unknown'
}
