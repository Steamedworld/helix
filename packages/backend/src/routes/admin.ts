import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { nodes, catalogTombstones } from '../db/schema'
import { ok } from '../lib/response'
import type { DrizzleDB } from '../db/client'
import { makeRequireAdmin } from '../middleware/auth'
import { computeSyncSafetyEstimate } from '../services/federation/catalogSync'
import { deriveSyncHealth } from '../services/federation/syncHealthRollup'
import { config, getPlaybackRefreshSecretHealth } from '../config'

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
    })
  })
}
