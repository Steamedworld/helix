import { randomBytes, createHash } from 'crypto'
import { eq } from 'drizzle-orm'
import { integrations } from '../../db/schema'
import type { DrizzleDB } from '../../db/client'
import { syncIntegration } from './service'

export function generateWebhookToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex')
  const hash = createHash('sha256').update(token).digest('hex')
  return { token, hash }
}

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function verifyWebhookToken(storedHash: string, providedToken: string): boolean {
  const hash = hashWebhookToken(providedToken)
  return hash === storedHash
}

// ─── Radarr payload ──────────────────────────────────────────────────────────

const RADARR_SYNC_EVENTS = new Set([
  'MovieAdded',
  'MovieDelete',
  'Download',
  'Rename',
  'Test',
])

export function parseRadarrEvent(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const eventType = (body as Record<string, unknown>).eventType
  return typeof eventType === 'string' ? eventType : null
}

export function shouldSyncOnRadarrEvent(eventType: string): boolean {
  return RADARR_SYNC_EVENTS.has(eventType)
}

// ─── Sonarr payload ──────────────────────────────────────────────────────────

const SONARR_SYNC_EVENTS = new Set([
  'SeriesAdd',
  'SeriesDelete',
  'EpisodeFileDelete',
  'Download',
  'Rename',
  'Test',
])

export function parseSonarrEvent(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const eventType = (body as Record<string, unknown>).eventType
  return typeof eventType === 'string' ? eventType : null
}

export function shouldSyncOnSonarrEvent(eventType: string): boolean {
  return SONARR_SYNC_EVENTS.has(eventType)
}

// ─── Sync debounce ───────────────────────────────────────────────────────────

type SyncState = 'running' | 'pending'
const syncStateMap = new Map<string, SyncState>()

export async function triggerWebhookSync(
  db: DrizzleDB,
  integrationId: string,
  dataDir: string
): Promise<void> {
  if (syncStateMap.get(integrationId) === 'running') {
    syncStateMap.set(integrationId, 'pending')
    return
  }

  syncStateMap.set(integrationId, 'running')
  try {
    await syncIntegration(db, integrationId, dataDir)
  } finally {
    const wasPending = syncStateMap.get(integrationId) === 'pending'
    syncStateMap.delete(integrationId)
    if (wasPending) {
      triggerWebhookSync(db, integrationId, dataDir).catch(() => {})
    }
  }
}

// Exposed for testing only
export function _getSyncState(): Map<string, SyncState> {
  return syncStateMap
}

// ─── Record webhook metadata ─────────────────────────────────────────────────

export async function recordWebhookReceived(
  db: DrizzleDB,
  integrationId: string,
  eventType: string | null,
  error: string | null
): Promise<void> {
  const now = Date.now()
  await db
    .update(integrations)
    .set({
      last_webhook_at: now,
      last_webhook_event: eventType ?? 'unknown',
      last_webhook_error: error,
      updated_at: now,
    })
    .where(eq(integrations.id, integrationId))
}
