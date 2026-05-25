import { createHmac, timingSafeEqual, randomBytes } from 'crypto'

// Module-level secret: use env var or generate a stable per-process random.
// In tests, all in-process requests share the same secret automatically.
const _secret = process.env.MEDIA_TOKEN_SECRET ?? randomBytes(32).toString('hex')

const DEFAULT_TTL_SECONDS = Number(process.env.MEDIA_TOKEN_TTL_SECONDS ?? 14400) // 4 hours

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64')
}

interface StreamPayload {
  purpose: 'stream'
  fid: string   // media_file_id
  uid: string   // user_id
  exp: number   // unix seconds
}

interface ArtworkPayload {
  purpose: 'artwork'
  mid: string   // media_item_id
  kind: 'poster' | 'backdrop'
  uid: string
  exp: number
}

type TokenPayload = StreamPayload | ArtworkPayload

function sign(payload: TokenPayload): string {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = b64url(createHmac('sha256', _secret).update(payloadB64).digest())
  return `${payloadB64}.${sig}`
}

function verify(token: string): TokenPayload | null {
  try {
    const dot = token.lastIndexOf('.')
    if (dot < 1) return null
    const payloadB64 = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const expectedSig = b64url(createHmac('sha256', _secret).update(payloadB64).digest())
    const a = Buffer.from(expectedSig, 'ascii')
    const b = Buffer.from(sig, 'ascii')
    if (a.length !== b.length) return null
    if (!timingSafeEqual(a, b)) return null
    const payload = JSON.parse(b64urlDecode(payloadB64).toString()) as TokenPayload
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export function signStreamToken(fileId: string, userId: string): string {
  return sign({
    purpose: 'stream',
    fid: fileId,
    uid: userId,
    exp: Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS,
  })
}

export function verifyStreamToken(token: string): { fileId: string; userId: string } | null {
  const payload = verify(token)
  if (!payload || payload.purpose !== 'stream') return null
  return { fileId: payload.fid, userId: payload.uid }
}

export function signArtworkToken(mediaItemId: string, kind: 'poster' | 'backdrop', userId: string): string {
  return sign({
    purpose: 'artwork',
    mid: mediaItemId,
    kind,
    uid: userId,
    exp: Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS,
  })
}

export function verifyArtworkToken(token: string): { mediaItemId: string; kind: 'poster' | 'backdrop'; userId: string } | null {
  const payload = verify(token)
  if (!payload || payload.purpose !== 'artwork') return null
  return { mediaItemId: payload.mid, kind: payload.kind, userId: payload.uid }
}
