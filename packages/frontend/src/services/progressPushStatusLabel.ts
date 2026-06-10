/**
 * Maps a watch_state.progress_push_status value to display copy.
 *
 * Rules:
 *   null / 'not_enabled'       → "Progress stored locally"
 *   'pending'                  → "Progress sync pending"
 *   'synced'                   → "Progress synced"
 *   'failed' / 'abandoned' /
 *   'source_unavailable'       → "Progress sync unavailable"
 *   anything else              → null (caller renders nothing)
 *
 * NEVER includes raw error text, node IDs, media IDs, tokens, or paths.
 */
export function progressPushStatusLabel(
  status: string | null | undefined
): 'Progress stored locally' | 'Progress sync pending' | 'Progress synced' | 'Progress sync unavailable' | null {
  if (!status || status === 'not_enabled') {
    return 'Progress stored locally'
  }
  if (status === 'pending') {
    return 'Progress sync pending'
  }
  if (status === 'synced') {
    return 'Progress synced'
  }
  if (status === 'failed' || status === 'abandoned' || status === 'source_unavailable') {
    return 'Progress sync unavailable'
  }
  return null
}
