import { createHmac } from 'crypto'

/**
 * Per-user viewer identity v1 — pure derivation + validation helpers.
 *
 * The viewer Home derives a stable, opaque, HMAC-keyed hash that identifies one
 * local user's progress on a source Home WITHOUT revealing the local user ID,
 * username, email, or any reversible identifier. The source stores the bare hash
 * and can never reverse it (it lacks the keying secret).
 *
 * Derivation: hmacSha256(secret, 'progress-user-v1:' + localNodeId + ':' + userId)[0..32]
 *
 * Properties:
 *   - Stable for the same (secret, localNodeId, userId).
 *   - Differs across users, nodes, and secrets.
 *   - Non-reversible by the source (keyed HMAC, not plain sha256).
 *   - 32 lowercase hex chars (128 bits) — collision-resistant against node-mode hashes.
 */

const VIEWER_IDENTITY_DOMAIN = 'progress-user-v1:'
const VIEWER_IDENTITY_HASH_RE = /^[a-f0-9]{32}$/

export function deriveViewerIdentityHash(secret: string, localNodeId: string, userId: string): string {
  return createHmac('sha256', secret)
    .update(VIEWER_IDENTITY_DOMAIN + localNodeId + ':' + userId)
    .digest('hex')
    .slice(0, 32)
}

export function isValidViewerIdentityHash(value: unknown): value is string {
  return typeof value === 'string' && VIEWER_IDENTITY_HASH_RE.test(value)
}
