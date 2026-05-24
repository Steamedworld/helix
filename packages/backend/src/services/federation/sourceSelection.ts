export interface PlaybackSource {
  nodeId: string
  nodeBaseUrl: string
  fileId: string
  filePath: string
  score: number  // lower = preferred
}

export async function selectBestSource(
  _mediaItemId: string,
  _userId: string
): Promise<PlaybackSource | null> {
  // TODO: multi-node federation — score and rank sources across all nodes
  // For now: return the single local file if it exists
  return null
}
