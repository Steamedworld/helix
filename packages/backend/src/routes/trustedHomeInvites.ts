/**
 * Trusted Home invite flow — admin-only endpoints.
 *
 * POST   /api/v1/trusted-home-invites          — create invite
 * GET    /api/v1/trusted-home-invites          — list invites (no token)
 * DELETE /api/v1/trusted-home-invites/:id      — revoke invite
 * POST   /api/v1/trusted-homes/accept-invite   — accept invite, connect remote home
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import { createHash, randomBytes } from 'crypto'
import { eq } from 'drizzle-orm'
import { trustedHomeInvites, nodes } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { makeRequireAdmin } from '../middleware/auth'
import { encryptApiKey } from '../services/integrations/encryption'
import { checkRemoteHealth } from '../services/federation/healthCheck'
import { fetchRemoteCapabilities } from '../services/federation/capabilities'
import { config, isLoopbackUrl } from '../config'

const MAX_EXPIRY_DAYS = 90

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Encode arbitrary JSON as base64url (no padding).
 */
function toBase64url(obj: unknown): string {
  const json = JSON.stringify(obj)
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Decode base64url → parsed JSON, or null on failure.
 */
function fromBase64url(encoded: string): unknown {
  try {
    const padded =
      encoded.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (encoded.length % 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Shape of the invite object returned once at creation.
 */
export interface InvitePayload {
  helix_invite: '1'
  home_name: string
  server_address: string
  token: string
  invite_id: string
  label: string | null
  expires_at: string | null
  generated_at: string
  warning: string
}

/**
 * Safe representation returned from list / after creation (no raw token).
 */
export interface InviteSummary {
  id: string
  label: string | null
  created_at: number
  expires_at: number | null
  used_at: number | null
  revoked_at: number | null
  created_by_user_id: string
}

function sanitizeInvite(row: typeof trustedHomeInvites.$inferSelect): InviteSummary {
  return {
    id: row.id,
    label: row.label,
    created_at: row.created_at,
    expires_at: row.expires_at ?? null,
    used_at: row.used_at ?? null,
    revoked_at: row.revoked_at ?? null,
    created_by_user_id: row.created_by_user_id,
  }
}

export async function trustedHomeInviteRoutes(
  app: FastifyInstance,
  opts: {
    db: DrizzleDB
    localNodeId: string
    dataDir: string
    baseUrl?: string | null
  }
) {
  const { db, localNodeId, dataDir } = opts
  const requireAdmin = makeRequireAdmin(db)

  // ─── POST /trusted-home-invites ───────────────────────────────────────────────
  app.post<{
    Body: { label?: string; expires_in_days?: number }
  }>('/', { preHandler: requireAdmin }, async (req, reply) => {
    const { label, expires_in_days } = req.body ?? {}

    // Validate expiry
    let expiresAtMs: number | null = null
    if (expires_in_days !== undefined) {
      const days = Number(expires_in_days)
      if (!Number.isFinite(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
        reply.status(400)
        return err(`expires_in_days must be between 1 and ${MAX_EXPIRY_DAYS}`)
      }
      expiresAtMs = Date.now() + days * 86400_000
    }

    // Resolve local node name for invite payload
    const [localNode] = await db
      .select({ name: nodes.name })
      .from(nodes)
      .where(eq(nodes.id, localNodeId))

    const homeName = localNode?.name ?? 'Helix'

    // Determine server address and warn if not safe
    const serverAddress =
      opts.baseUrl ?? config.baseUrl ?? null

    let baseUrlWarning: string | undefined
    if (!serverAddress) {
      baseUrlWarning = 'BASE_URL is not configured on this home. The invite will not include a server address — the connecting admin will need to enter it manually.'
    } else if (isLoopbackUrl(serverAddress)) {
      baseUrlWarning = 'BASE_URL is set to a loopback address. Remote homes will not be able to reach this server. Set BASE_URL to a LAN, VPN, or HTTPS reverse-proxy URL.'
    }

    // Generate token
    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)
    const now = Date.now()
    const id = crypto.randomUUID()

    await db.insert(trustedHomeInvites).values({
      id,
      token_hash: tokenHash,
      label: label ?? null,
      expires_at: expiresAtMs,
      used_at: null,
      revoked_at: null,
      created_by_user_id: req.user!.id,
      created_at: now,
      updated_at: now,
    })

    const payload: InvitePayload = {
      helix_invite: '1',
      home_name: homeName,
      server_address: serverAddress ?? '',
      token: rawToken,
      invite_id: id,
      label: label ?? null,
      expires_at: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
      generated_at: new Date(now).toISOString(),
      warning:
        'Share this invite only with the admin of a trusted Helix home. ' +
        'It grants server-to-server access to your configured libraries. ' +
        'Treat it like a password.',
    }

    const compact = toBase64url(payload)

    return ok({
      invite: payload,
      compact,
      ...(baseUrlWarning ? { base_url_warning: baseUrlWarning } : {}),
    })
  })

  // ─── GET /trusted-home-invites ────────────────────────────────────────────────
  app.get('/', { preHandler: requireAdmin }, async () => {
    const rows = await db
      .select()
      .from(trustedHomeInvites)
      .orderBy(trustedHomeInvites.created_at)
    return ok(rows.map(sanitizeInvite))
  })

  // ─── DELETE /trusted-home-invites/:id ─────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply: FastifyReply) => {
      const [row] = await db
        .select()
        .from(trustedHomeInvites)
        .where(eq(trustedHomeInvites.id, req.params.id))

      if (!row) {
        reply.status(404)
        return err('Invite not found')
      }

      const now = Date.now()
      await db
        .update(trustedHomeInvites)
        .set({ revoked_at: now, updated_at: now })
        .where(eq(trustedHomeInvites.id, req.params.id))

      return ok({ revoked: true, id: req.params.id })
    }
  )
}

export async function acceptInviteRoutes(
  app: FastifyInstance,
  opts: {
    db: DrizzleDB
    localNodeId: string
    dataDir: string
    baseUrl?: string | null
  }
) {
  const { db, dataDir } = opts
  const requireAdmin = makeRequireAdmin(db)

  // ─── POST /trusted-homes/accept-invite ───────────────────────────────────────
  app.post<{ Body: { invite?: string } }>(
    '/accept-invite',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { invite: inviteRaw } = req.body ?? {}

      if (!inviteRaw || typeof inviteRaw !== 'string') {
        reply.status(400)
        return err('invite field is required (base64url compact form or JSON string)')
      }

      // Try to parse — accept either raw JSON or base64url
      let parsed: unknown
      const trimmed = inviteRaw.trim()
      if (trimmed.startsWith('{')) {
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          reply.status(400)
          return err('Invite JSON is malformed')
        }
      } else {
        parsed = fromBase64url(trimmed)
        if (!parsed) {
          reply.status(400)
          return err('Invite string is not valid base64url JSON')
        }
      }

      // Validate required fields
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('helix_invite' in parsed) ||
        !('server_address' in parsed) ||
        !('token' in parsed) ||
        !('invite_id' in parsed)
      ) {
        reply.status(400)
        return err('Invite is missing required fields (helix_invite, server_address, token, invite_id)')
      }

      const inv = parsed as Record<string, unknown>

      if (inv.helix_invite !== '1') {
        reply.status(400)
        return err(`Unsupported invite version: ${String(inv.helix_invite)}`)
      }

      const serverAddress = String(inv.server_address ?? '').trim()
      const rawToken = String(inv.token ?? '').trim()
      const homeName = String(inv.home_name ?? 'Remote Helix').trim()

      if (!serverAddress) {
        reply.status(400)
        return err('Invite server_address is empty. The inviting home may not have BASE_URL configured.')
      }

      try {
        new URL(serverAddress)
      } catch {
        reply.status(400)
        return err('Invite server_address is not a valid URL')
      }

      if (!rawToken) {
        reply.status(400)
        return err('Invite token is empty')
      }

      // Deduplication — check if this server_address is already connected
      const existing = await db
        .select({ id: nodes.id, name: nodes.name, status: nodes.status })
        .from(nodes)
        .where(eq(nodes.base_url, serverAddress))

      const existingRemote = existing.find((n) => n.id !== opts.localNodeId)
      if (existingRemote) {
        return ok({
          already_connected: true,
          message: `A Trusted Home at ${serverAddress} is already registered as "${existingRemote.name}".`,
          node_id: existingRemote.id,
          node_name: existingRemote.name,
          node_status: existingRemote.status,
        })
      }

      // Test remote health with provided token
      const health = await checkRemoteHealth(serverAddress, rawToken)
      if (!health.online) {
        reply.status(502)
        return err(
          `Could not reach the home at ${serverAddress}: ${health.error ?? 'connection failed'}. ` +
          'Verify the server address and that the invite has not expired.'
        )
      }

      // Fetch capabilities
      const capabilities = await fetchRemoteCapabilities(serverAddress, rawToken)

      // Create the remote node — store encrypted token (mirrors existing manual flow)
      const nodeId = crypto.randomUUID()
      const nowIso = new Date().toISOString()
      const nowMs = Date.now()
      const api_token_encrypted = encryptApiKey(rawToken, dataDir)

      await db.insert(nodes).values({
        id: nodeId,
        name: homeName,
        kind: 'remote',
        base_url: serverAddress,
        status: 'online',
        api_token_encrypted,
        last_seen_at: nowMs,
        capabilities_json: capabilities ? JSON.stringify(capabilities) : null,
        created_at: nowIso,
        updated_at: nowIso,
      })

      // Mark invite used on our own invite table if the invite_id matches a local invite
      // (this home created it and re-connected using it — unusual but handle gracefully)
      const inviteId = String(inv.invite_id ?? '').trim()
      if (inviteId) {
        await db
          .update(trustedHomeInvites)
          .set({ used_at: nowMs, updated_at: nowMs })
          .where(eq(trustedHomeInvites.id, inviteId))
          .catch(() => { /* no-op: invite may belong to remote home */ })
      }

      return ok({
        connected: true,
        node_id: nodeId,
        node_name: homeName,
        server_address: serverAddress,
        capabilities: capabilities ?? null,
        sync_available: true,
        message:
          'Trusted Home connected. After connecting, choose which libraries users can access from this home in Library settings.',
      })
    }
  )
}
