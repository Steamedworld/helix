import type { FastifyInstance } from 'fastify'
import { sql, desc, and, gt } from 'drizzle-orm'
import { nodes, catalogTombstones, federatedProgressOutbox, trustedHomeAuditEvents } from '../db/schema'
import { ok, err } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { makeRequireAdmin } from '../middleware/auth'
import { computeSyncSafetyEstimate } from '../services/federation/catalogSync'
import { deriveSyncHealth } from '../services/federation/syncHealthRollup'
import { config, getPlaybackRefreshSecretHealth } from '../config'

// Safe label for MEDIA_TOKEN_SECRET health
function getMediaTokenSecretHealth(): 'explicit_secret' | 'not_configured' {
  return process.env.MEDIA_TOKEN_SECRET ? 'explicit_secret' : 'not_configured'
}

export async function adminRoutes(
  app: FastifyInstance,
  opts: { db: DrizzleDB }
) {
  const { db } = opts
  const requireAdmin = makeRequireAdmin(db)

  // GET /admin/sync-diagnostics — read-only overview of tombstone stats and per-node sync status
  app.get('/admin/sync-diagnostics', { preHandler: requireAdmin }, async () => {
    const tombstoneRetentionDays = config.tombstoneRetentionDays
    const now = new Date()
    const pruneCutoff = new Date(now.getTime() - tombstoneRetentionDays * 24 * 60 * 60 * 1000)
    const pruneCutoffIso = pruneCutoff.toISOString()

    // ─── Tombstone stats ────────────────────────────────────────────────────────

    // Total count
    const totalRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(catalogTombstones)
    const total = Number(totalRows[0].count)

    // Counts by entity type
    const byTypeRows = await db
      .select({
        entityType: catalogTombstones.entity_type,
        count: sql<number>`count(*)`,
      })
      .from(catalogTombstones)
      .groupBy(catalogTombstones.entity_type)

    const byEntityType: Record<string, number> = {}
    for (const row of byTypeRows) {
      byEntityType[row.entityType] = Number(row.count)
    }

    // Age buckets (compute cutoffs in ISO strings)
    const now7Iso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const now30Iso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const under7Rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(catalogTombstones)
      .where(sql`${catalogTombstones.deleted_at} > ${now7Iso}`)
    const under7Days = Number(under7Rows[0].count)

    const days7To30Rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(catalogTombstones)
      .where(sql`${catalogTombstones.deleted_at} <= ${now7Iso} AND ${catalogTombstones.deleted_at} > ${now30Iso}`)
    const days7To30 = Number(days7To30Rows[0].count)

    const days30ToRetentionRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(catalogTombstones)
      .where(sql`${catalogTombstones.deleted_at} <= ${now30Iso} AND ${catalogTombstones.deleted_at} > ${pruneCutoffIso}`)
    const days30ToRetention = Number(days30ToRetentionRows[0].count)

    const olderThanRetentionRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(catalogTombstones)
      .where(sql`${catalogTombstones.deleted_at} <= ${pruneCutoffIso}`)
    const olderThanRetention = Number(olderThanRetentionRows[0].count)

    // Oldest and newest deleted_at
    const extremesRows = await db
      .select({
        oldest: sql<string | null>`min(${catalogTombstones.deleted_at})`,
        newest: sql<string | null>`max(${catalogTombstones.deleted_at})`,
      })
      .from(catalogTombstones)

    const oldest = extremesRows[0].oldest ?? null
    const newest = extremesRows[0].newest ?? null

    // ─── Trusted home sync status ───────────────────────────────────────────────

    const remoteNodes = await db
      .select({
        id: nodes.id,
        name: nodes.name,
        status: nodes.status,
        last_sync_at: nodes.last_sync_at,
        last_sync_mode: nodes.last_sync_mode,
        last_sync_fallback_reason: nodes.last_sync_fallback_reason,
        last_sync_items_synced: nodes.last_sync_items_synced,
        last_sync_versions_synced: nodes.last_sync_versions_synced,
        last_sync_files_synced: nodes.last_sync_files_synced,
        last_sync_tombstones_applied: nodes.last_sync_tombstones_applied,
        last_sync_libraries_removed: nodes.last_sync_libraries_removed,
        last_sync_items_removed: nodes.last_sync_items_removed,
        last_sync_versions_removed: nodes.last_sync_versions_removed,
        last_sync_files_removed: nodes.last_sync_files_removed,
        last_sync_attempt_at: nodes.last_sync_attempt_at,
        last_sync_error_at: nodes.last_sync_error_at,
        last_sync_error_code: nodes.last_sync_error_code,
        last_sync_error_message: nodes.last_sync_error_message,
      })
      .from(nodes)
      .where(sql`${nodes.kind} = 'remote'`)

    const trustedHomeSync = remoteNodes.map((node) => {
      // last_sync_at is stored as epoch ms (integer); convert to ISO for the helper
      const lastSyncIso = node.last_sync_at != null
        ? new Date(node.last_sync_at).toISOString()
        : null

      const safetyEstimate = computeSyncSafetyEstimate(
        lastSyncIso,
        tombstoneRetentionDays,
        now
      )

      const hasActiveSyncError = node.last_sync_error_code !== null

      const syncHealth = deriveSyncHealth(
        node.last_sync_attempt_at,
        node.last_sync_at,
        node.last_sync_error_code,
        safetyEstimate.nextSyncReason,
        tombstoneRetentionDays
      )

      return {
        nodeId: node.id,
        name: node.name,
        status: node.status,
        lastSuccessfulSyncAt: node.last_sync_at != null
          ? new Date(node.last_sync_at).toISOString()
          : null,
        lastSyncMode: node.last_sync_mode ?? null,
        lastFallbackReason: node.last_sync_fallback_reason ?? null,
        lastSyncCounts: {
          itemsSynced: node.last_sync_items_synced,
          versionsSynced: node.last_sync_versions_synced,
          filesSynced: node.last_sync_files_synced,
          tombstonesApplied: node.last_sync_tombstones_applied,
          librariesRemoved: node.last_sync_libraries_removed,
          itemsRemoved: node.last_sync_items_removed,
          versionsRemoved: node.last_sync_versions_removed,
          filesRemoved: node.last_sync_files_removed,
        },
        tombstoneRetentionDays,
        ...safetyEstimate,
        lastSyncAttemptAt: node.last_sync_attempt_at ?? null,
        lastSyncErrorAt: node.last_sync_error_at ?? null,
        lastSyncErrorCode: node.last_sync_error_code ?? null,
        lastSyncErrorMessage: node.last_sync_error_message ?? null,
        hasActiveSyncError,
        syncHealth,
      }
    })

    // ─── Secrets health ─────────────────────────────────────────────────────────
    // State only — MUST NOT include secret value, hash, env var contents, or token examples.

    const playbackRefreshState = getPlaybackRefreshSecretHealth()
    const playbackRefreshRecommendation: string | null =
      playbackRefreshState === 'derived_fallback'
        ? 'Set TRUSTED_HOME_PLAYBACK_REFRESH_SECRET for explicit key isolation.'
        : playbackRefreshState === 'dev_random'
        ? 'Random per-process key in use (development only). Set TRUSTED_HOME_PLAYBACK_REFRESH_SECRET or MEDIA_TOKEN_SECRET for persistent tokens.'
        : playbackRefreshState === 'missing'
        ? 'No signing secret configured. Production startup will fail. Set TRUSTED_HOME_PLAYBACK_REFRESH_SECRET.'
        : null

    const secretsHealth = {
      playbackRefreshToken: {
        state: playbackRefreshState,
        ...(playbackRefreshRecommendation !== null ? { recommendation: playbackRefreshRecommendation } : {}),
      },
      mediaToken: {
        state: getMediaTokenSecretHealth(),
        recommendation:
          getMediaTokenSecretHealth() === 'not_configured'
            ? 'Set MEDIA_TOKEN_SECRET for signed media token signing key isolation.'
            : null,
      },
    }

    // ─── Playback diagnostics ───────────────────────────────────────────────────
    // State only — MUST NOT expose secret values, node IDs in histograms, paths, tokens,
    // raw errors, or env var contents.

    const proxyEnabled = config.trustedHomePlaybackProxyEnabled

    // Count remote nodes with active playback issue (code IS NOT NULL)
    const homesWithIssueRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(nodes)
      .where(sql`${nodes.kind} = 'remote' AND ${nodes.last_playback_issue_code} IS NOT NULL`)
    const homesWithPlaybackIssue = Number(homesWithIssueRows[0].count)

    // Count remote nodes with valid base_url (proxy potentially available)
    const homesWithProxyRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(nodes)
      .where(sql`${nodes.kind} = 'remote' AND ${nodes.base_url} IS NOT NULL`)
    const homesWithProxyAvailable = Number(homesWithProxyRows[0].count)

    // Aggregate last_playback_issue_code counts across all remote nodes (per-code histogram)
    // NEVER include node IDs in the histogram
    const issueCodeRows = await db
      .select({
        code: nodes.last_playback_issue_code,
        count: sql<number>`count(*)`,
      })
      .from(nodes)
      .where(sql`${nodes.kind} = 'remote' AND ${nodes.last_playback_issue_code} IS NOT NULL`)
      .groupBy(nodes.last_playback_issue_code)

    const recentProxyFailures: Record<string, number> = {
      remote_unreachable: 0,
      remote_unauthorized: 0,
      range_failed: 0,
      proxy_disabled: 0,
      unknown: 0,
    }
    for (const row of issueCodeRows) {
      const code = row.code ?? 'unknown'
      if (code in recentProxyFailures) {
        recentProxyFailures[code] = Number(row.count)
      } else {
        recentProxyFailures['unknown'] = (recentProxyFailures['unknown'] ?? 0) + Number(row.count)
      }
    }

    const playbackDiagnostics = {
      proxyEnabled,
      recentProxyFailures,
      refreshTokenHealth: {
        state: playbackRefreshState,
        ttlMs: config.trustedHomePlaybackRefreshTokenTtlMs,
        recommendation: playbackRefreshRecommendation,
      },
      homesWithPlaybackIssue,
      homesWithProxyAvailable,
    }

    // ─── Progress outbox aggregate diagnostics ──────────────────────────────────
    // Aggregate counts only — NEVER include job IDs, node IDs, media IDs,
    // payload details, user IDs, tokens, raw error bodies, paths, or stack traces.

    const outboxStatusRows = await db
      .select({
        status: federatedProgressOutbox.status,
        count: sql<number>`count(*)`,
      })
      .from(federatedProgressOutbox)
      .groupBy(federatedProgressOutbox.status)

    const outboxCounts: Record<string, number> = {
      pending: 0,
      in_progress: 0,
      synced: 0,
      failed: 0,
      abandoned: 0,
    }
    for (const row of outboxStatusRows) {
      if (row.status in outboxCounts) {
        outboxCounts[row.status] = Number(row.count)
      }
    }

    // Oldest pending job age bucket (helps spot stuck queues)
    const oldestPendingRows = await db
      .select({ oldest: sql<string | null>`min(${federatedProgressOutbox.next_attempt_at})` })
      .from(federatedProgressOutbox)
      .where(sql`${federatedProgressOutbox.status} IN ('pending', 'failed')`)

    const oldestPendingAt = oldestPendingRows[0]?.oldest ?? null
    let oldestPendingAgeBucket: 'under_1h' | '1h_to_6h' | 'over_6h' | null = null
    if (oldestPendingAt) {
      const ageMs = now.getTime() - new Date(oldestPendingAt).getTime()
      if (ageMs < 3600_000) {
        oldestPendingAgeBucket = 'under_1h'
      } else if (ageMs < 21600_000) {
        oldestPendingAgeBucket = '1h_to_6h'
      } else {
        oldestPendingAgeBucket = 'over_6h'
      }
    }

    // Error code histogram (safe labels only — no job/node/media IDs)
    const errorCodeRows = await db
      .select({
        code: federatedProgressOutbox.last_error_code,
        count: sql<number>`count(*)`,
      })
      .from(federatedProgressOutbox)
      .where(sql`${federatedProgressOutbox.last_error_code} IS NOT NULL`)
      .groupBy(federatedProgressOutbox.last_error_code)

    const lastErrorCodeCounts: Record<string, number> = {
      remote_unreachable: 0,
      auth_failed: 0,
      timeout: 0,
      network_error: 0,
      config_disabled: 0,
      unknown: 0,
    }
    for (const row of errorCodeRows) {
      const code = row.code ?? 'unknown'
      if (code in lastErrorCodeCounts) {
        lastErrorCodeCounts[code] = Number(row.count)
      } else {
        lastErrorCodeCounts['unknown'] = (lastErrorCodeCounts['unknown'] ?? 0) + Number(row.count)
      }
    }

    const progressOutbox = {
      pending: outboxCounts.pending,
      inProgress: outboxCounts.in_progress,
      synced: outboxCounts.synced,
      failed: outboxCounts.failed,
      abandoned: outboxCounts.abandoned,
      oldestPendingAgeBucket,
      lastErrorCodeCounts,
    }

    // ─── Audit event aggregate (last 24h) ────────────────────────────────────────
    // Aggregate counts only — NEVER include event IDs, node IDs in histograms,
    // media IDs, user IDs, tokens, raw error bodies, paths, or stack traces.

    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

    const auditCountRows = await db
      .select({
        action: trustedHomeAuditEvents.action,
        result: trustedHomeAuditEvents.result,
        count: sql<number>`count(*)`,
      })
      .from(trustedHomeAuditEvents)
      .where(gt(trustedHomeAuditEvents.occurred_at, since24h))
      .groupBy(trustedHomeAuditEvents.action, trustedHomeAuditEvents.result)

    const auditMap: Record<string, Record<string, number>> = {}
    for (const row of auditCountRows) {
      if (!auditMap[row.action]) auditMap[row.action] = {}
      auditMap[row.action][row.result] = Number(row.count)
    }

    function auditCount(action: string, result?: string): number {
      if (!auditMap[action]) return 0
      if (result) return auditMap[action][result] ?? 0
      return Object.values(auditMap[action]).reduce((a, b) => a + b, 0)
    }

    const auditSummary = {
      last24h: {
        settingsChanges: auditCount('trusted_home_settings_changed', 'success'),
        progressPushEnqueued: auditCount('progress_push_enqueued', 'success'),
        progressPushSynced: auditCount('progress_push_synced', 'success'),
        progressPushFailed: auditCount('progress_push_failed', 'error'),
        progressPushAbandoned: auditCount('progress_push_abandoned', 'error'),
        progressReadDenied: auditCount('remote_progress_read_denied', 'denied'),
        progressReceived: auditCount('remote_progress_received', 'success'),
        progressStaleIgnored: auditCount('remote_progress_received', 'skipped'),
        playbackProxyAttempts: auditCount('playback_proxy_attempt', 'success'),
        playbackProxyErrors: auditCount('playback_proxy_attempt', 'error'),
      },
    }

    return ok({
      tombstoneStats: {
        total,
        byEntityType,
        ageBuckets: {
          under7Days,
          days7To30,
          days30ToRetention,
          olderThanRetention,
        },
        oldestDeletedAt: oldest,
        newestDeletedAt: newest,
        tombstoneRetentionDays,
        pruneCutoff: pruneCutoffIso,
      },
      trustedHomeSync,
      secretsHealth,
      playbackDiagnostics,
      progressOutbox,
      auditSummary,
    })
  })

  // GET /admin/audit-events — paginated audit event read (admin only)
  //
  // Query params:
  //   ?limit=50       — max rows to return (capped at 200, default 50)
  //   ?offset=0       — pagination offset (default 0)
  //   ?action=<str>   — filter by action
  //
  // Response MUST NOT include: user_id, federation token, raw error body,
  // filesystem path, Authorization header, stack trace, username, email,
  // credential material, or remote_viewer_hash.
  app.get<{
    Querystring: { limit?: string; offset?: string; action?: string }
  }>('/admin/audit-events', { preHandler: requireAdmin }, async (req, reply) => {
    const rawLimit = parseInt(req.query.limit ?? '50', 10)
    const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 50 : rawLimit, 200)
    const rawOffset = parseInt(req.query.offset ?? '0', 10)
    const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset
    const actionFilter = req.query.action?.trim() || undefined

    const VALID_ACTIONS = [
      'trusted_home_settings_changed',
      'progress_push_enqueued',
      'progress_push_synced',
      'progress_push_abandoned',
      'progress_push_failed',
      'remote_progress_read_denied',
      'remote_progress_received',
      'playback_proxy_attempt',
    ]

    if (actionFilter && !VALID_ACTIONS.includes(actionFilter)) {
      reply.status(400)
      return err(`Invalid action filter. Valid values: ${VALID_ACTIONS.join(', ')}`)
    }

    const whereClause = actionFilter
      ? and(sql`${trustedHomeAuditEvents.action} = ${actionFilter}`)
      : undefined

    const [totalRow, events] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(trustedHomeAuditEvents)
        .where(whereClause),
      db
        .select({
          id: trustedHomeAuditEvents.id,
          occurred_at: trustedHomeAuditEvents.occurred_at,
          action: trustedHomeAuditEvents.action,
          result: trustedHomeAuditEvents.result,
          reason_code: trustedHomeAuditEvents.reason_code,
          node_id: trustedHomeAuditEvents.node_id,
          context_json: trustedHomeAuditEvents.context_json,
        })
        .from(trustedHomeAuditEvents)
        .where(whereClause)
        .orderBy(desc(trustedHomeAuditEvents.occurred_at))
        .limit(limit)
        .offset(offset),
    ])

    return ok({
      events: events.map((e) => ({
        id: e.id,
        occurredAt: e.occurred_at,
        action: e.action,
        result: e.result,
        reasonCode: e.reason_code ?? null,
        nodeId: e.node_id ?? null,
        context: (() => {
          try {
            return e.context_json ? JSON.parse(e.context_json) : null
          } catch {
            return null
          }
        })(),
      })),
      total: Number(totalRow[0]?.count ?? 0),
      limit,
      offset,
    })
  })
}
