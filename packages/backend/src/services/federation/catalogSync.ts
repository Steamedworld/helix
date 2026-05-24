import type { MediaItem } from '@helix/shared'

export async function pushCatalogUpdate(_items: MediaItem[]): Promise<void> {
  // TODO: multi-node federation — push catalog changes to remote nodes
}

export async function pullCatalogUpdates(_nodeId: string): Promise<MediaItem[]> {
  // TODO: multi-node federation — pull catalog changes from a remote node
  return []
}
