import { eq } from 'drizzle-orm'
import { nodes } from '../../db/schema'
import type { DrizzleDB } from '../../db/client'
import { logger } from '../../lib/logger'
import type { SyncRemoteNodeResult } from './catalogSync'

// ─── Per-node in-progress lock ────────────────────────────────────────────────
//
// A Set<nodeId> shared between the scheduler and the manual-sync route so that:
//   - The scheduler skips nodes already being synced manually.
//   - The manual sync endpoint returns 409 while the scheduler is syncing.
//
// Module-level so the same Set is used across imports within the same process.

export const syncInProgress = new Set<string>()

// ─── Config shape ─────────────────────────────────────────────────────────────

export interface TrustedHomeSyncConfig {
  enabled: boolean
  intervalMs: number
  staggerMs: number
  onStartup: boolean
}

// ─── Sync function signature ──────────────────────────────────────────────────

export type SyncFn = (
  nodeId: string,
  baseUrl: string,
  apiTokenEncrypted: string,
  dataDir: string,
  db: DrizzleDB,
  opts?: { lastSyncAt?: number | null; force?: boolean }
) => Promise<SyncRemoteNodeResult>

// ─── Scheduler ───────────────────────────────────────────────────────────────

export interface TrustedHomeSyncScheduler {
  start(): void
  stop(): Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createTrustedHomeSyncScheduler(
  db: DrizzleDB,
  dataDir: string,
  cfg: TrustedHomeSyncConfig,
  syncFn: SyncFn
): TrustedHomeSyncScheduler {
  let active = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  // Track in-flight tick so stop() can wait for it
  let tickPromise: Promise<void> | null = null

  async function runTick(): Promise<void> {
    // Query all remote (non-local) nodes
    let remoteNodes: Array<{
      id: string
      name: string
      base_url: string | null
      api_token_encrypted: string | null
      last_sync_at: number | null
    }>

    try {
      remoteNodes = await db
        .select({
          id: nodes.id,
          name: nodes.name,
          base_url: nodes.base_url,
          api_token_encrypted: nodes.api_token_encrypted,
          last_sync_at: nodes.last_sync_at,
        })
        .from(nodes)
        .where(eq(nodes.kind, 'remote'))
    } catch (e) {
      logger.warn({ err: e }, '[trustedHomeSync] Failed to query remote nodes for scheduled sync')
      return
    }

    for (let i = 0; i < remoteNodes.length; i++) {
      if (!active) break

      const node = remoteNodes[i]

      // Stagger: wait before each node (including the first, unless it's the only one)
      if (i > 0 && cfg.staggerMs > 0) {
        await delay(cfg.staggerMs)
      }

      if (!active) break

      // Skip nodes that are missing required fields
      if (!node.base_url || !node.api_token_encrypted) {
        logger.warn({ nodeId: node.id, name: node.name }, '[trustedHomeSync] Skipping node: missing base_url or api_token')
        continue
      }

      // Per-node lock: skip if already in progress
      if (syncInProgress.has(node.id)) {
        logger.info({ nodeId: node.id, name: node.name }, '[trustedHomeSync] Skipping node: sync already in progress')
        continue
      }

      syncInProgress.add(node.id)
      try {
        const result = await syncFn(
          node.id,
          node.base_url,
          node.api_token_encrypted,
          dataDir,
          db,
          { lastSyncAt: node.last_sync_at }
        )

        // Update last_sync_at on success
        const nowMs = Date.now()
        await db
          .update(nodes)
          .set({
            status: 'online',
            last_seen_at: nowMs,
            last_sync_at: nowMs,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .where(eq(nodes.id, node.id))

        logger.info(
          {
            nodeId: node.id,
            name: node.name,
            itemsSynced: result.itemsSynced,
            incremental: result.incremental,
            fallbackUsed: result.fallbackUsed,
          },
          '[trustedHomeSync] Scheduled sync completed'
        )
      } catch (e) {
        // Record error but do NOT rethrow — other nodes must still sync
        const errMsg = e instanceof Error ? e.message : String(e)
        logger.warn(
          { err: e, nodeId: node.id, name: node.name },
          '[trustedHomeSync] Scheduled sync failed'
        )
        try {
          await db
            .update(nodes)
            .set({
              status: 'error',
              last_error: errMsg,
              updated_at: new Date().toISOString(),
            })
            .where(eq(nodes.id, node.id))
        } catch {
          // Best-effort DB update — ignore secondary failure
        }
      } finally {
        syncInProgress.delete(node.id)
      }
    }
  }

  function scheduleNext(): void {
    if (!active) return
    pendingTimer = setTimeout(() => {
      if (!active) return
      tickPromise = runTick().then(() => {
        tickPromise = null
        scheduleNext()
      }).catch(() => {
        tickPromise = null
        scheduleNext()
      })
    }, cfg.intervalMs)
  }

  return {
    start(): void {
      if (!cfg.enabled) return
      if (active) return
      active = true

      if (cfg.onStartup) {
        // Fire immediately
        tickPromise = runTick().then(() => {
          tickPromise = null
          scheduleNext()
        }).catch(() => {
          tickPromise = null
          scheduleNext()
        })
      } else {
        scheduleNext()
      }
    },

    async stop(): Promise<void> {
      active = false
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer)
        pendingTimer = null
      }
      // Wait for any in-flight tick to drain
      if (tickPromise) {
        await tickPromise.catch(() => {})
        tickPromise = null
      }
    },
  }
}
