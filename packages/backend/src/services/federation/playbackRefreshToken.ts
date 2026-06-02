import { createHmac, timingSafeEqual, randomBytes } from 'crypto'

/**
 * Signed playback refresh tokens — short-lived, scoped, tamper-resistant.
 *
 * Encoding:  base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
 * Algorithm: HMAC-SHA256
 * Signing:   timingSafeEqual used for all signature comparison (constant-time)
 *
 * Payload fields:
 *   v       — token version (must be 1)
 *   purpose — fixed string "playback_refresh" (prevents cross-purpose reuse)
 *   sub     — userId (subject)
 *   sid     — session binding hash: SHA-256(rawSessionToken)[0..31]
 *             OR sessionId (opaque DB UUID) — never the raw session token value
 *   nodeId  — source Trusted Home node ID
 *   mediaId — media item ID
 *   iat     — issued-at (unix seconds)
 *   exp     — expiry (unix seconds)
 *   nonce   — 16 random bytes hex — prevents token reuse across refresh cycles
 *
 * Security guarantees:
 *   - Raw session token NEVER appears in payload (only a hash / opaque DB ID)
 *   - Federation bearer token NEVER appears in payload
 *   - Filesystem paths NEVER appear in payload
 *   - Signing secret NEVER appears in any log, response body, or error
 *   - All comparison is constant-time (timingSafeEqual)
 *   - Token errors map to a single opaque RefreshTokenError — callers must
 *     map all errors to the same 401 response to prevent oracle attacks
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface PlaybackRefreshPayload {
  v: 1
  purpose: 'playback_refresh'
  sub: string      // userId
  sid: string      // session binding: SHA-256(rawToken)[0..31] or sessionId
  nodeId: string
  mediaId: string
  iat: number      // issued-at (unix seconds)
  exp: number      // expiry (unix seconds)
  nonce: string    // 16 random bytes hex
}

export type RefreshTokenError =
  | 'malformed'
  | 'expired'
  | 'tampered'
  | 'wrong_purpose'
  | 'wrong_scope'   // nodeId/mediaId/userId/session mismatch

export type VerifyResult =
  | { ok: true; payload: PlaybackRefreshPayload }
  | { ok: false; error: RefreshTokenError }

// ─── Base64url helpers ────────────────────────────────────────────────────────

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function b64urlDecode(s: string): Buffer {
  const padded = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(s.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64')
}

// ─── Session binding ──────────────────────────────────────────────────────────

/**
 * Derive a session binding value from the raw session token.
 *
 * We never store the raw token in the signed payload — we store the first
 * 32 hex characters of its SHA-256 hash.  This lets the refresh endpoint
 * verify the token was issued for the same session without exposing the
 * actual session credential.
 *
 * If only a sessionId (opaque DB UUID) is available instead of the raw
 * token, pass it as sessionId — it is already not sensitive.
 */
export function deriveSessionBinding(rawSessionToken: string): string {
  const { createHash } = require('crypto') as typeof import('crypto')
  return createHash('sha256').update(rawSessionToken).digest('hex').slice(0, 32)
}

// ─── Sign ─────────────────────────────────────────────────────────────────────

export function signPlaybackRefreshToken(
  payload: Omit<PlaybackRefreshPayload, 'v' | 'purpose' | 'iat' | 'exp' | 'nonce'>,
  secret: string,
  ttlMs: number
): string {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + Math.floor(ttlMs / 1000)
  const nonce = randomBytes(16).toString('hex')

  const fullPayload: PlaybackRefreshPayload = {
    v: 1,
    purpose: 'playback_refresh',
    sub: payload.sub,
    sid: payload.sid,
    nodeId: payload.nodeId,
    mediaId: payload.mediaId,
    iat,
    exp,
    nonce,
  }

  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(fullPayload)))
  const sig = b64urlEncode(
    createHmac('sha256', secret).update(payloadB64).digest()
  )
  return `${payloadB64}.${sig}`
}

// ─── Verify ───────────────────────────────────────────────────────────────────

export function verifyPlaybackRefreshToken(
  token: string,
  secret: string
): VerifyResult {
  // 1. Split into payload + signature parts
  const dot = token.lastIndexOf('.')
  if (dot < 1) {
    return { ok: false, error: 'malformed' }
  }

  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)

  // 2. Constant-time signature verification (prevents timing attacks)
  let expectedSigBuf: Buffer
  try {
    expectedSigBuf = createHmac('sha256', secret).update(payloadB64).digest()
  } catch {
    return { ok: false, error: 'malformed' }
  }

  let receivedSigBuf: Buffer
  try {
    receivedSigBuf = b64urlDecode(sigB64)
  } catch {
    return { ok: false, error: 'malformed' }
  }

  if (expectedSigBuf.length !== receivedSigBuf.length) {
    // Length mismatch — use a dummy comparison to maintain constant time
    timingSafeEqual(expectedSigBuf, expectedSigBuf)
    return { ok: false, error: 'tampered' }
  }

  if (!timingSafeEqual(expectedSigBuf, receivedSigBuf)) {
    return { ok: false, error: 'tampered' }
  }

  // 3. Decode and parse payload (only after signature verification)
  let payload: unknown
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'))
  } catch {
    return { ok: false, error: 'malformed' }
  }

  // 4. Structural validation
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return { ok: false, error: 'malformed' }
  }

  const p = payload as Record<string, unknown>

  if (p.v !== 1) {
    return { ok: false, error: 'malformed' }
  }
  if (p.purpose !== 'playback_refresh') {
    return { ok: false, error: 'wrong_purpose' }
  }
  if (
    typeof p.sub !== 'string' ||
    typeof p.sid !== 'string' ||
    typeof p.nodeId !== 'string' ||
    typeof p.mediaId !== 'string' ||
    typeof p.iat !== 'number' ||
    typeof p.exp !== 'number' ||
    typeof p.nonce !== 'string'
  ) {
    return { ok: false, error: 'malformed' }
  }

  // 5. Expiry check
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (p.exp < nowSeconds) {
    return { ok: false, error: 'expired' }
  }

  return {
    ok: true,
    payload: p as unknown as PlaybackRefreshPayload,
  }
}
