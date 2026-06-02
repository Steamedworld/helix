import type { FastifyInstance } from 'fastify'
import { eq, and, inArray } from 'drizzle-orm'
import { nodes, mediaItems, mediaFiles, libraries, libraryPermissions, users } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { makeRequireAdmin, makeRequireAuth } from '../middleware/auth'
import { encryptApiKey, decryptApiKey } from '../services/integrations/encryption'
import { checkRemoteHealth } from '../services/federation/healthCheck'
import { syncRemoteNode } from '../services/federation/catalogSync'
import { syncInProgress } from '../services/federation/trustedHomeSyncScheduler'
import { classifySyncError } from '../services/federation/syncErrorClassifier'
import { canViewLibrary, canPlayLibrary } from '../lib/permissions'
import { fetchRemoteCapabilities, type NodeCapabilities } from '../services/federation/capabilities'
import { isLoopbackUrl, config } from '../config'

type NodeRow = typeof nodes.$inferSelect

function sanitizeNode(node: NodeRow) {
  const { api_token_encrypted: _t, federation_token_hash: _h, capabilities_json: _c, ...rest } = node
  const capabilities = node.capabilities_json
    ? (() => { try { return JSON.parse(node.capabilities_json) } catch { return null } })()
    : null
  return {
    ...rest,
    has_federation_token:
      node.kind === 'local' ? !!node.federation_token_hash : !!node.api_token_encrypted,
    capabilities,
  }
}

// ─── Direct playback diagnostic ───────────────────────────────────────────────

export interface DirectPlaybackDiagnostic {
  directPlaybackAvailable: boolean
  supportsRemotePlayback: boolean
  baseUrlConfigured: boolean
  publicBaseUrl: string | null
  warning?: string
}

function buildDirectPlaybackDiagnostic(
  capabilities: NodeCapabilities | null,
  remoteBaseUrl: string
): DirectPlaybackDiagnostic {
  if (!capabilities) {
    return {
      directPlaybackAvailable: false,
      supportsRemotePlayback: false,
      baseUrlConfigured: false,
      publicBaseUrl: null,
      warning: 'Remote node capabilities are unknown. Run Test or Sync to fetch them.',
    }
  }

  const supportsRemotePlayback = capabilities.supportsRemotePlayback === true
  const baseUrlConfigured = capabilities.baseUrlConfigured === true
  const publicBaseUrl = capabilities.publicBaseUrl ?? null

  if (!supportsRemotePlayback) {
    return {
      directPlaybackAvailable: false,
      supportsRemotePlayback: false,
      baseUrlConfigured,
      publicBaseUrl,
      warning: 'Remote node does not support direct playback.',
    }
  }

  // Check if public base URL points to a loopback address
  const effectiveStreamHost = publicBaseUrl ?? remoteBaseUrl
  if (!baseUrlConfigured || isLoopbackUrl(effectiveStreamHost)) {
    const loopbackAddr = publicBaseUrl ?? remoteBaseUrl
    return {
      directPlaybackAvailable: true,
      supportsRemotePlayback: true,
      baseUrlConfigured: false,
      publicBaseUrl,
      warning:
        `Remote node BASE_URL is not configured or is a loopback address.` +
        ` Direct playback may fail unless your browser is on the same machine as the remote node (${loopbackAddr}).`,
    }
  }

  return {
    directPlaybackAvailable: true,
    supportsRemotePlayback: true,
    baseUrlConfigured: true,
    publicBaseUrl,
  }
}

export async function nodeRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB; localNodeId: string; dataDir: string }
) {
  const { db, localNodeId, dataDir } = opts
  const requireAdmin = makeRequireAdmin(db)
  const requireAuth = makeRequireAuth(db)

  // GET / — list all nodes
  app.get('/', { preHandler: requireAdmin }, async () => {
    const rows = await db.select().from(nodes)
    return ok(rows.map(sanitizeNode))
  })

  // POST / — add remote node
  app.post<{ Body: { name?: string; base_url?: string; api_token?: string } }>(
    '/',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { name, base_url, api_token } = req.body ?? {}
      if (!name || !base_url || !api_token) {
        reply.status(400)
        return err('name, base_url, and api_token are required')
      }
      try {
        new URL(base_url)
      } catch {
        reply.status(400)
        return err('base_url must be a valid URL')
      }
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const api_token_encrypted = encryptApiKey(api_token, dataDir)
      await db.insert(nodes).values({
        id,
        name,
        kind: 'remote',
        base_url,
        status: 'unknown',
        api_token_encrypted,
        created_at: now,
        updated_at: now,
      })
      const [created] = await db.select().from(nodes).where(eq(nodes.id, id))
      reply.status(201)
      return ok(sanitizeNode(created))
    }
  )

  // GET /:id — node detail
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
    if (!node) {
      reply.status(404)
      return err('Node not found')
    }
    return ok(sanitizeNode(node))
  })

  // PATCH /:id — update remote node
  app.patch<{
    Params: { id: string }
    Body: Partial<{ name: string; base_url: string; api_token: string }>
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
    if (!node) {
      reply.status(404)
      return err('Node not found')
    }
    if (node.kind === 'local') {
      reply.status(400)
      return err('Cannot modify the local node via this endpoint')
    }
    const now = new Date().toISOString()
    const updates: Partial<typeof nodes.$inferInsert> = { updated_at: now }
    if (req.body?.name) updates.name = req.body.name
    if (req.body?.base_url) {
      try {
        new URL(req.body.base_url)
      } catch {
        reply.status(400)
        return err('base_url must be a valid URL')
      }
      updates.base_url = req.body.base_url
    }
    if (req.body?.api_token) {
      updates.api_token_encrypted = encryptApiKey(req.body.api_token, dataDir)
    }
    await db.update(nodes).set(updates).where(eq(nodes.id, req.params.id))
    const [updated] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
    return ok(sanitizeNode(updated))
  })

  // DELETE /:id — disconnect a Trusted Home node with explicit catalog cleanup
  //
  // Removes in order (inside a transaction):
  //   1. library_permissions rows for all libraries belonging to this node
  //   2. media_files rows scoped to this node and its libraries
  //   3. media_items rows in those libraries
  //   4. libraries rows belonging to this node
  //   5. the node row itself
  //
  // NEVER touches local library or media rows. All deletions are scoped to the
  // target node's library IDs. Foreign-key cascades would handle most of this
  // when foreign_keys=ON, but we do it explicitly to: (a) return a cleanup
  // summary, and (b) make the safety invariant auditable in code.
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id: targetId } = req.params
      const [node] = await db.select().from(nodes).where(eq(nodes.id, targetId))
      if (!node) {
        reply.status(404)
        return err('Node not found')
      }
      if (node.kind === 'local') {
        reply.status(400)
        return err('Cannot disconnect the local home')
      }

      // Collect library IDs belonging only to this node (pre-transaction read is safe)
      const nodeLibraries = await db
        .select({ id: libraries.id })
        .from(libraries)
        .where(eq(libraries.node_id, targetId))
      const libraryIds = nodeLibraries.map((l) => l.id)

      // Run all cleanup inside a single transaction — atomic or nothing.
      // db.transaction() is synchronous for better-sqlite3 and returns the
      // callback's return value directly.
      const result = db.transaction((tx) => {
        let librariesRemoved = 0
        let mediaItemsRemoved = 0
        let mediaFilesRemoved = 0
        let grantsRemoved = 0

        if (libraryIds.length > 0) {
          // 1. Remove all library_permissions for this node's libraries
          const grantRows = tx
            .delete(libraryPermissions)
            .where(inArray(libraryPermissions.library_id, libraryIds))
            .returning({ id: libraryPermissions.id })
            .all()
          grantsRemoved = grantRows.length

          // 2. Delete media_files scoped to this node and its libraries
          const fileRows = tx
            .delete(mediaFiles)
            .where(
              and(
                eq(mediaFiles.node_id, targetId),
                inArray(mediaFiles.library_id, libraryIds)
              )
            )
            .returning({ id: mediaFiles.id })
            .all()
          mediaFilesRemoved = fileRows.length

          // 3. Delete media_items in this node's libraries
          const itemRows = tx
            .delete(mediaItems)
            .where(inArray(mediaItems.library_id, libraryIds))
            .returning({ id: mediaItems.id })
            .all()
          mediaItemsRemoved = itemRows.length

          // 4. Delete the libraries themselves
          const libRows = tx
            .delete(libraries)
            .where(eq(libraries.node_id, targetId))
            .returning({ id: libraries.id })
            .all()
          librariesRemoved = libRows.length
        }

        // 5. Delete the node itself
        tx.delete(nodes).where(eq(nodes.id, targetId)).run()

        return { librariesRemoved, mediaItemsRemoved, mediaFilesRemoved, grantsRemoved }
      })

      return ok({
        nodeRemoved: true,
        ...result,
      })
    }
  )

  // DELETE /:id/access — bulk revoke all library_permissions for a node's libraries
  //
  // Does NOT remove libraries or media items — only removes the grant rows so
  // users lose access. The connection and catalog remain intact.
  app.delete<{ Params: { id: string } }>(
    '/:id/access',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id: nodeId } = req.params
      const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
      if (!node) {
        reply.status(404)
        return err('Node not found')
      }

      if (node.kind === 'local') {
        reply.status(400)
        return err('Cannot bulk-revoke access on the local home')
      }

      // Find all libraries belonging to this node
      const nodeLibraries = await db
        .select({ id: libraries.id })
        .from(libraries)
        .where(eq(libraries.node_id, nodeId))
      const libraryIds = nodeLibraries.map((l) => l.id)

      if (libraryIds.length === 0) {
        return ok({ grantsRemoved: 0 })
      }

      // Delete all library_permissions rows for those libraries
      const deleted = await db
        .delete(libraryPermissions)
        .where(inArray(libraryPermissions.library_id, libraryIds))
        .returning({ id: libraryPermissions.id })

      return ok({ grantsRemoved: deleted.length })
    }
  )

  // POST /:id/test — test connection to remote node
  app.post<{ Params: { id: string } }>(
    '/:id/test',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
      if (!node) {
        reply.status(404)
        return err('Node not found')
      }
      if (node.kind === 'local') {
        reply.status(400)
        return err('Cannot test the local node')
      }
      if (!node.base_url || !node.api_token_encrypted) {
        reply.status(400)
        return err('Node is missing base_url or api_token')
      }
      const rawToken = decryptApiKey(node.api_token_encrypted, dataDir)
      const now = Date.now()
      const result = await checkRemoteHealth(node.base_url, rawToken)
      if (result.online) {
        const capabilities = await fetchRemoteCapabilities(node.base_url, rawToken)
        await db
          .update(nodes)
          .set({
            status: 'online',
            last_seen_at: now,
            last_error: null,
            capabilities_json: capabilities ? JSON.stringify(capabilities) : null,
            updated_at: new Date().toISOString(),
          })
          .where(eq(nodes.id, node.id))
        return ok({ online: true, capabilities: capabilities ?? null })
      } else {
        await db
          .update(nodes)
          .set({
            status: 'error',
            last_error: result.error ?? 'Connection failed',
            updated_at: new Date().toISOString(),
          })
          .where(eq(nodes.id, node.id))
        return ok({ online: false, error: result.error })
      }
    }
  )

  // POST /:id/sync — sync remote catalog
  // Query params:
  //   ?force=true  — ignore last_sync_at and do a full sync regardless
  //
  // Default behaviour:
  //   - If node.last_sync_at is null → full sync
  //   - If node.last_sync_at is set  → incremental sync (?since=<last_sync_at>)
  //     - Remote returns 400 for ?since → fall back to full sync, sets fallbackUsed=true
  //     - Any other remote error → 500, does NOT update last_sync_at
  //
  // last_sync_at is updated ONLY on success.
  app.post<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/:id/sync',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
      if (!node) {
        reply.status(404)
        return err('Node not found')
      }
      if (node.kind === 'local') {
        reply.status(400)
        return err('Cannot sync the local node')
      }
      if (!node.base_url || !node.api_token_encrypted) {
        reply.status(400)
        return err('Node is missing base_url or api_token')
      }
      const force = req.query.force === 'true' || req.query.force === '1'

      // Reject if a background or concurrent sync is already in progress for this node
      if (syncInProgress.has(node.id)) {
        reply.status(409)
        return err('Sync already in progress for this node')
      }

      syncInProgress.add(node.id)
      try {
        // Record that an attempt is starting
        await db
          .update(nodes)
          .set({ last_sync_attempt_at: new Date().toISOString() })
          .where(eq(nodes.id, node.id))

        const nowMs = Date.now()
        const rawTokenForSync = decryptApiKey(node.api_token_encrypted, dataDir)
        const [syncResult, capabilities] = await Promise.all([
          syncRemoteNode(node.id, node.base_url, node.api_token_encrypted, dataDir, db, {
            lastSyncAt: node.last_sync_at,
            force,
            tombstoneRetentionDays: config.tombstoneRetentionDays,
          }),
          fetchRemoteCapabilities(node.base_url, rawTokenForSync),
        ])
        // Success: update sync counts and clear current error state.
        // last_sync_error_at is intentionally preserved — it records when the last error occurred,
        // not whether an error is currently active. Active error state = last_sync_error_code IS NOT NULL.
        await db
          .update(nodes)
          .set({
            status: 'online',
            last_seen_at: nowMs,
            last_sync_at: nowMs,
            last_error: null,
            capabilities_json: capabilities ? JSON.stringify(capabilities) : null,
            last_sync_mode: syncResult.fullSync ? 'full' : 'incremental',
            last_sync_fallback_reason: syncResult.fallbackReason ?? null,
            last_sync_items_synced: syncResult.itemsSynced,
            last_sync_versions_synced: syncResult.versionsSynced,
            last_sync_files_synced: syncResult.filesSynced,
            last_sync_tombstones_applied: syncResult.tombstonesApplied,
            last_sync_libraries_removed: syncResult.librariesRemoved,
            last_sync_items_removed: syncResult.itemsRemoved,
            last_sync_versions_removed: syncResult.versionsRemoved,
            last_sync_files_removed: syncResult.filesRemoved,
            last_sync_diagnostics_updated_at: new Date().toISOString(),
            last_sync_error_code: null,
            last_sync_error_message: null,
            updated_at: new Date().toISOString(),
          })
          .where(eq(nodes.id, node.id))
        return ok({ ...syncResult, synced: true, capabilities: capabilities ?? null })
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Sync failed'
        const classified = classifySyncError(e)
        // Failure: record safe error details but do NOT overwrite last successful sync count fields
        await db
          .update(nodes)
          .set({
            status: 'error',
            last_error: errMsg,
            last_sync_error_at: new Date().toISOString(),
            last_sync_error_code: classified.code,
            last_sync_error_message: classified.safeMessage,
            updated_at: new Date().toISOString(),
          })
          .where(eq(nodes.id, node.id))
        reply.status(500)
        return err(classified.safeMessage)
      } finally {
        syncInProgress.delete(node.id)
      }
    }
  )

  // GET /:id/check — fetch and evaluate direct-playback readiness for a remote node
  app.get<{ Params: { id: string } }>(
    '/:id/check',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const [node] = await db.select().from(nodes).where(eq(nodes.id, req.params.id))
      if (!node) {
        reply.status(404)
        return err('Node not found')
      }
      if (node.kind === 'local') {
        reply.status(400)
        return err('Cannot check the local node')
      }
      if (!node.base_url || !node.api_token_encrypted) {
        reply.status(400)
        return err('Node is missing base_url or api_token')
      }

      // Use cached capabilities if available (from last test/sync); optionally
      // refresh by passing ?refresh=1. This avoids a slow network call on every load.
      let capabilities: NodeCapabilities | null = node.capabilities_json
        ? (() => { try { return JSON.parse(node.capabilities_json) as NodeCapabilities } catch { return null } })()
        : null

      if (!capabilities) {
        // No cached capabilities — try to fetch them now
        const rawToken = decryptApiKey(node.api_token_encrypted, dataDir)
        capabilities = await fetchRemoteCapabilities(node.base_url, rawToken)
        if (capabilities) {
          await db
            .update(nodes)
            .set({ capabilities_json: JSON.stringify(capabilities), updated_at: new Date().toISOString() })
            .where(eq(nodes.id, node.id))
        }
      }

      const diagnostic = buildDirectPlaybackDiagnostic(capabilities, node.base_url)

      // Build remotePlayback summary for admin visibility
      const proxyEnabled = config.trustedHomePlaybackProxyEnabled
      const hasCredentials = !!(node.api_token_encrypted)
      const nodeAddress = node.base_url

      let recommendedMode: 'proxy' | 'direct' | 'unavailable'
      const warnings: string[] = []

      if (proxyEnabled && hasCredentials) {
        recommendedMode = 'proxy'
      } else if (diagnostic.directPlaybackAvailable) {
        recommendedMode = 'direct'
        if (!diagnostic.baseUrlConfigured || isLoopbackUrl(nodeAddress)) {
          warnings.push('Source Home address may not be reachable from browser')
        }
      } else {
        recommendedMode = 'unavailable'
      }

      if (!proxyEnabled) {
        warnings.push('Proxy playback is disabled (TRUSTED_HOME_PLAYBACK_PROXY_ENABLED=false)')
      }

      const remotePlayback = {
        proxyAvailable: proxyEnabled && hasCredentials,
        directPlaybackAvailable: diagnostic.directPlaybackAvailable,
        recommendedMode,
        warnings,
      }

      return ok({ ...diagnostic, remotePlayback })
    }
  )

  // GET /:nodeId/media/:mediaId/artwork/:kind — proxy remote artwork to authenticated user
  app.get<{ Params: { nodeId: string; mediaId: string; kind: string } }>(
    '/:nodeId/media/:mediaId/artwork/:kind',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { nodeId, mediaId, kind } = req.params

      if (kind !== 'poster' && kind !== 'backdrop') {
        reply.status(400)
        return err('kind must be "poster" or "backdrop"')
      }

      const user = req.user!

      // Verify user has permission to view the media item
      const [item] = await db
        .select({ library_id: mediaItems.library_id })
        .from(mediaItems)
        .where(eq(mediaItems.id, mediaId))

      if (!item) {
        reply.status(404)
        return err('Media item not found')
      }

      if (!await canViewLibrary(user, item.library_id, db)) {
        reply.status(404)
        return err('Media item not found')
      }

      // Look up remote node and decrypt token
      const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
      if (!node || node.kind !== 'remote' || !node.base_url || !node.api_token_encrypted) {
        reply.status(404)
        return err('Remote node not found')
      }

      const rawToken = decryptApiKey(node.api_token_encrypted, dataDir)

      let remoteRes: Response
      try {
        remoteRes = await fetch(
          `${node.base_url}/api/v1/federation/media/${mediaId}/artwork/${kind}`,
          {
            headers: { Authorization: `Bearer ${rawToken}` },
            signal: AbortSignal.timeout(15000),
          }
        )
      } catch {
        reply.status(502)
        return err('Remote node unreachable')
      }

      if (remoteRes.status === 404) {
        reply.status(404)
        return err('Artwork not available on remote node')
      }

      if (!remoteRes.ok) {
        reply.status(502)
        return err('Remote node returned an error')
      }

      const contentType = remoteRes.headers.get('content-type') ?? 'application/octet-stream'
      const buffer = Buffer.from(await remoteRes.arrayBuffer())

      reply.header('Content-Type', contentType)
      reply.header('Content-Length', String(buffer.length))
      reply.header('Cache-Control', 'public, max-age=86400')
      return reply.send(buffer)
    }
  )

  // ─── Trusted Home access management ──────────────────────────────────────────

  /**
   * GET /:id/access-summary — per-library grant summary for a remote node (admin only).
   *
   * Returns:
   *   { node: { id, name, address }, libraries: [ { id, name, kind, grants, ungrantedUsers } ] }
   *
   * - Only returns libraries belonging to this node.
   * - Never exposes password_hash, token_hash, or credential fields.
   * - ungrantedUsers = non-admin users with no grant row for that library.
   */
  app.get<{ Params: { id: string } }>(
    '/:id/access-summary',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id: nodeId } = req.params

      const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
      if (!node) {
        reply.status(404)
        return err('Node not found')
      }

      // Get libraries for this node
      const nodeLibraries = await db
        .select()
        .from(libraries)
        .where(eq(libraries.node_id, nodeId))

      // Get all non-admin users
      const allUsers = await db
        .select({
          id: users.id,
          display_name: users.display_name,
          username: users.username,
          role: users.role,
        })
        .from(users)
        .where(eq(users.disabled, 0))

      const nonAdminUsers = allUsers.filter((u) => u.role !== 'admin')

      // Build library summaries
      const librarySummaries = await Promise.all(
        nodeLibraries.map(async (lib) => {
          const perms = await db
            .select({
              user_id: libraryPermissions.user_id,
              can_view: libraryPermissions.can_view,
              can_play: libraryPermissions.can_play,
              display_name: users.display_name,
              username: users.username,
            })
            .from(libraryPermissions)
            .innerJoin(users, eq(libraryPermissions.user_id, users.id))
            .where(eq(libraryPermissions.library_id, lib.id))

          const grantedUserIds = new Set(perms.map((p) => p.user_id))

          const grants = perms.map((p) => ({
            userId: p.user_id,
            userName: p.display_name ?? p.username ?? p.user_id,
            canView: p.can_view,
            canPlay: p.can_play,
          }))

          const ungrantedUsers = nonAdminUsers
            .filter((u) => !grantedUserIds.has(u.id))
            .map((u) => ({
              userId: u.id,
              userName: u.display_name ?? u.username ?? u.id,
            }))

          return {
            id: lib.id,
            name: lib.name,
            kind: lib.kind,
            grants,
            ungrantedUsers,
          }
        })
      )

      return ok({
        node: {
          id: node.id,
          name: node.name,
          address: node.base_url ?? null,
        },
        libraries: librarySummaries,
      })
    }
  )

  /**
   * PUT /:id/access — bulk upsert library permissions for a remote node (admin only).
   *
   * Body: { grants: [ { libraryId, userId, canView, canPlay } ] }
   *
   * - Validates each libraryId belongs to this node (403 if not).
   * - Upserts into library_permissions.
   * - canView: false + canPlay: false effectively revokes.
   * - Idempotent.
   * - Returns updated access summary for affected libraries.
   */
  app.put<{
    Params: { id: string }
    Body: { grants: Array<{ libraryId: string; userId: string; canView: boolean; canPlay: boolean }> }
  }>(
    '/:id/access',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id: nodeId } = req.params
      const { grants } = req.body ?? {}

      const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
      if (!node) {
        reply.status(404)
        return err('Node not found')
      }

      if (!Array.isArray(grants) || grants.length === 0) {
        reply.status(400)
        return err('grants array is required and must not be empty')
      }

      // Get libraries for this node
      const nodeLibraries = await db
        .select({ id: libraries.id })
        .from(libraries)
        .where(eq(libraries.node_id, nodeId))
      const nodeLibraryIdSet = new Set(nodeLibraries.map((l) => l.id))

      // Validate all libraryIds belong to this node
      for (const grant of grants) {
        if (!nodeLibraryIdSet.has(grant.libraryId)) {
          reply.status(403)
          return err(`Library ${grant.libraryId} does not belong to node ${nodeId}`)
        }
      }

      const now = new Date().toISOString()
      const affectedLibraryIds = new Set<string>()

      // Upsert each grant
      for (const grant of grants) {
        affectedLibraryIds.add(grant.libraryId)

        // Check for admin users — skip silently (admins always have access)
        const [targetUser] = await db
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, grant.userId))
          .limit(1)
        if (targetUser?.role === 'admin') continue

        const [existing] = await db
          .select()
          .from(libraryPermissions)
          .where(
            and(
              eq(libraryPermissions.library_id, grant.libraryId),
              eq(libraryPermissions.user_id, grant.userId)
            )
          )
          .limit(1)

        if (existing) {
          await db
            .update(libraryPermissions)
            .set({ can_view: grant.canView, can_play: grant.canPlay, updated_at: now })
            .where(eq(libraryPermissions.id, existing.id))
        } else {
          await db.insert(libraryPermissions).values({
            id: crypto.randomUUID(),
            library_id: grant.libraryId,
            user_id: grant.userId,
            can_view: grant.canView,
            can_play: grant.canPlay,
            created_at: now,
            updated_at: now,
          })
        }
      }

      // Return updated summary for affected libraries
      const affectedIds = Array.from(affectedLibraryIds)
      const updatedLibraries = await db
        .select()
        .from(libraries)
        .where(inArray(libraries.id, affectedIds))

      const allNonAdminUsers = await db
        .select({
          id: users.id,
          display_name: users.display_name,
          username: users.username,
          role: users.role,
        })
        .from(users)
        .where(eq(users.disabled, 0))
      const nonAdminUsers = allNonAdminUsers.filter((u) => u.role !== 'admin')

      const updatedSummaries = await Promise.all(
        updatedLibraries.map(async (lib) => {
          const perms = await db
            .select({
              user_id: libraryPermissions.user_id,
              can_view: libraryPermissions.can_view,
              can_play: libraryPermissions.can_play,
              display_name: users.display_name,
              username: users.username,
            })
            .from(libraryPermissions)
            .innerJoin(users, eq(libraryPermissions.user_id, users.id))
            .where(eq(libraryPermissions.library_id, lib.id))

          const grantedUserIds = new Set(perms.map((p) => p.user_id))

          return {
            id: lib.id,
            name: lib.name,
            kind: lib.kind,
            grants: perms.map((p) => ({
              userId: p.user_id,
              userName: p.display_name ?? p.username ?? p.user_id,
              canView: p.can_view,
              canPlay: p.can_play,
            })),
            ungrantedUsers: nonAdminUsers
              .filter((u) => !grantedUserIds.has(u.id))
              .map((u) => ({ userId: u.id, userName: u.display_name ?? u.username ?? u.id })),
          }
        })
      )

      return ok({ updated: true, libraries: updatedSummaries })
    }
  )

  // ─── Trusted Home playback proxy ──────────────────────────────────────────────

  /**
   * GET  /nodes/:nodeId/media/:mediaId/stream
   * HEAD /nodes/:nodeId/media/:mediaId/stream
   *
   * Proxies a media stream from a Trusted Home to the authenticated browser.
   * Authentication: user session cookie.
   *
   * Security:
   *   - Requires session auth
   *   - Verifies node is a remote Trusted Home
   *   - Verifies mediaItem belongs to nodeId (no cross-node confusion)
   *   - Checks can_play permission for the remote library (admins bypass)
   *   - Upstream URL constructed ONLY from stored node.base_url (SSRF prevention)
   *   - Only forwards Range header upstream; never forwards auth or other browser headers
   *   - Strips all credential/auth headers from upstream response
   *   - Returns 503 if proxy feature is disabled
   */
  async function handleNodeMediaStream(
    req: import('fastify').FastifyRequest<{ Params: { nodeId: string; mediaId: string } }>,
    reply: import('fastify').FastifyReply
  ) {
    if (!config.trustedHomePlaybackProxyEnabled) {
      reply.status(503)
      return err('Trusted Home playback proxy is disabled')
    }

    const { nodeId, mediaId } = req.params
    const user = req.user!

    // 1. Find node — must be a remote Trusted Home
    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
    if (!node) {
      reply.status(404)
      return err('Node not found')
    }
    if (node.kind !== 'remote' || !node.base_url || !node.api_token_encrypted) {
      reply.status(404)
      return err('Node not found')
    }

    // 2. Find media item — must belong to this node
    const [item] = await db
      .select({ id: mediaItems.id, library_id: mediaItems.library_id })
      .from(mediaItems)
      .innerJoin(libraries, eq(mediaItems.library_id, libraries.id))
      .where(
        and(
          eq(mediaItems.id, mediaId),
          eq(libraries.node_id, nodeId)
        )
      )

    if (!item) {
      reply.status(404)
      return err('Media item not found')
    }

    // 3. Check can_play permission for the remote library (admins bypass)
    const allowed = await canPlayLibrary(user, item.library_id, db)
    if (!allowed) {
      reply.status(403)
      return err('Playback not permitted for this library')
    }

    // 4. Decrypt stored token (server-side only — never sent to browser)
    let rawToken: string
    try {
      rawToken = decryptApiKey(node.api_token_encrypted, dataDir)
    } catch {
      reply.status(502)
      return err('Unable to access media from this Home')
    }

    // 5. Build upstream URL from stored node address ONLY (SSRF prevention)
    const upstreamUrl = `${node.base_url}/api/v1/federation/media/${mediaId}/stream`

    // 6. Forward only Range header from browser to upstream
    const upstreamHeaders: Record<string, string> = {
      Authorization: `Bearer ${rawToken}`,
    }
    const rangeHeader = req.headers.range
    if (rangeHeader) {
      upstreamHeaders['Range'] = rangeHeader
    }

    // 7. Make upstream request with timeout tied to AbortController
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), config.trustedHomeProxyRequestTimeoutMs)

    // Abort upstream if browser disconnects
    req.raw.on('close', () => controller.abort())

    let upstreamRes: Response
    try {
      upstreamRes = await fetch(
        req.method === 'HEAD' ? upstreamUrl : upstreamUrl,
        {
          method: req.method as 'GET' | 'HEAD',
          headers: upstreamHeaders,
          signal: controller.signal,
        }
      )
    } catch (fetchErr) {
      clearTimeout(timeoutId)
      reply.status(502)
      return err('Unable to reach this Home')
    } finally {
      clearTimeout(timeoutId)
    }

    // 8. Map upstream status codes
    const upstreamStatus = upstreamRes.status

    if (upstreamStatus === 401 || upstreamStatus === 403) {
      reply.status(502)
      return err('Unable to access media from this Home')
    }

    if (upstreamStatus === 404) {
      reply.status(404)
      return err('Media unavailable from this Home')
    }

    if (upstreamStatus === 416) {
      // Forward 416 with Content-Range if present
      const cr = upstreamRes.headers.get('content-range')
      if (cr) reply.header('Content-Range', cr)
      reply.status(416)
      return reply.send()
    }

    if (upstreamStatus >= 500) {
      reply.status(502)
      return err('Remote Home is temporarily unavailable')
    }

    if (upstreamStatus !== 200 && upstreamStatus !== 206) {
      reply.status(502)
      return err('Remote Home is temporarily unavailable')
    }

    // 9. Forward ONLY safe headers from upstream to browser
    const SAFE_UPSTREAM_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges']
    for (const h of SAFE_UPSTREAM_HEADERS) {
      const val = upstreamRes.headers.get(h)
      if (val !== null) {
        reply.header(h, val)
      }
    }

    reply.status(upstreamStatus)

    // HEAD: headers only, no body
    if (req.method === 'HEAD') {
      return reply.send()
    }

    // 10. Stream body — pipe upstream response body to reply
    if (!upstreamRes.body) {
      return reply.send()
    }

    // Use Node.js stream from fetch response body
    const { Readable } = await import('stream')
    const readable = Readable.fromWeb(upstreamRes.body as import('stream/web').ReadableStream<Uint8Array>)

    // Destroy readable if browser disconnects
    req.raw.on('close', () => readable.destroy())

    return reply.send(readable)
  }

  app.get<{ Params: { nodeId: string; mediaId: string } }>(
    '/:nodeId/media/:mediaId/stream',
    { preHandler: requireAuth },
    handleNodeMediaStream
  )

  app.head<{ Params: { nodeId: string; mediaId: string } }>(
    '/:nodeId/media/:mediaId/stream',
    { preHandler: requireAuth },
    handleNodeMediaStream
  )
}
