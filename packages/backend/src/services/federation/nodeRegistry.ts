import type { Node } from '@helix/shared'

export async function registerNode(_node: Node): Promise<void> {
  // TODO: multi-node federation — broadcast node registration to federation peers
}

export async function discoverNodes(): Promise<Node[]> {
  // TODO: multi-node federation — query known peers for their node lists
  return []
}
