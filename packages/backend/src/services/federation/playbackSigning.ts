export function signPlaybackUrl(
  nodeBaseUrl: string,
  fileId: string,
  _userId: string
): string {
  // TODO: multi-node federation — generate signed playback URL for a remote node
  // For now: return a direct local path stub
  return `${nodeBaseUrl}/api/v1/stream/${fileId}`
}
