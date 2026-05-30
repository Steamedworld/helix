import type { DrizzleDB } from '../../db/client'
import { catalogTombstones } from '../../db/schema'

export type TombstoneReason = 'scan_missing' | 'integration_delete' | 'admin_disconnect' | 'unknown'
export type TombstoneEntityType = 'library' | 'media_item' | 'media_version' | 'media_file'

/**
 * Record a tombstone for a single deleted entity.
 *
 * nodeId must always be the LOCAL node id — tombstones are announcements that
 * THIS home deleted something. Never pass a remote node id here.
 */
export async function recordTombstone(
  db: DrizzleDB,
  nodeId: string,
  entityType: TombstoneEntityType,
  entityId: string,
  reason: TombstoneReason = 'unknown'
): Promise<void> {
  const now = new Date().toISOString()
  await db.insert(catalogTombstones).values({
    id: crypto.randomUUID(),
    node_id: nodeId,
    entity_type: entityType,
    entity_id: entityId,
    deleted_at: now,
    reason,
    created_at: now,
  })
}

/**
 * Record tombstones for a batch of deleted entities of the same type.
 *
 * nodeId must always be the LOCAL node id.
 * No-op if entityIds is empty.
 */
export async function recordTombstones(
  db: DrizzleDB,
  nodeId: string,
  entityType: TombstoneEntityType,
  entityIds: string[],
  reason: TombstoneReason = 'unknown'
): Promise<void> {
  if (entityIds.length === 0) return
  const now = new Date().toISOString()
  await db.insert(catalogTombstones).values(
    entityIds.map((entityId) => ({
      id: crypto.randomUUID(),
      node_id: nodeId,
      entity_type: entityType,
      entity_id: entityId,
      deleted_at: now,
      reason,
      created_at: now,
    }))
  )
}
