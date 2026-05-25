import { eq, and } from 'drizzle-orm'
import { integrations, externalMediaLinks } from '../../db/schema'
import type { DrizzleDB } from '../../db/client'
import type { SyncResult } from './types'
import { decryptApiKey } from './encryption'
import { fetchMovies } from './providers/radarr'
import { fetchSeries } from './providers/sonarr'
import { mapRadarrMovies, mapSonarrSeries } from './mapping'
import { enrichmentQueue } from '../enrichmentQueue'

const MAX_ITEMS_PER_SYNC = 1000

/**
 * Run a sync for one integration.
 * - Fetches movies/series from Arr
 * - Maps to Helix items
 * - Upserts into external_media_links (idempotent)
 * - Updates integration.last_synced_at
 */
export async function syncIntegration(
  db: DrizzleDB,
  integrationId: string,
  dataDir: string
): Promise<SyncResult> {
  const result: SyncResult = {
    itemsFetched: 0,
    itemsMapped: 0,
    linksCreated: 0,
    linksUpdated: 0,
    errors: [],
  }

  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, integrationId), eq(integrations.enabled, 1)))

  if (!integration) {
    result.errors.push('Integration not found or disabled')
    return result
  }

  let apiKey: string
  try {
    apiKey = decryptApiKey(integration.api_key_encrypted, dataDir)
  } catch (err: unknown) {
    result.errors.push(`Failed to decrypt API key: ${err instanceof Error ? err.message : String(err)}`)
    return result
  }

  const now = Date.now()

  const mappedHelixIds: string[] = []

  try {
    if (integration.kind === 'radarr') {
      const movies = await fetchMovies(integration.base_url, apiKey)
      const limited = movies.slice(0, MAX_ITEMS_PER_SYNC)
      result.itemsFetched = limited.length

      const mapped = await mapRadarrMovies(db, limited)
      result.itemsMapped = mapped.length

      for (const { helixItemId, arrMovie } of mapped) {
        mappedHelixIds.push(helixItemId)
        if (!arrMovie) continue
        const externalKind = 'radarr_movie' as const
        const externalId = String(arrMovie.externalId)

        // Check for existing link
        const [existing] = await db
          .select({ id: externalMediaLinks.id })
          .from(externalMediaLinks)
          .where(
            and(
              eq(externalMediaLinks.integration_id, integrationId),
              eq(externalMediaLinks.external_kind, externalKind),
              eq(externalMediaLinks.external_id, externalId)
            )
          )

        if (existing) {
          await db
            .update(externalMediaLinks)
            .set({
              external_title: arrMovie.title,
              monitored: arrMovie.monitored ? 1 : 0,
              quality_profile: arrMovie.qualityProfileName ?? null,
              root_path: arrMovie.path ?? null,
              last_synced_at: now,
              updated_at: now,
            })
            .where(eq(externalMediaLinks.id, existing.id))
          result.linksUpdated++
        } else {
          await db.insert(externalMediaLinks).values({
            id: crypto.randomUUID(),
            media_item_id: helixItemId,
            integration_id: integrationId,
            external_kind: externalKind,
            external_id: externalId,
            external_guid: null,
            external_title: arrMovie.title,
            monitored: arrMovie.monitored ? 1 : 0,
            quality_profile: arrMovie.qualityProfileName ?? null,
            root_path: arrMovie.path ?? null,
            last_synced_at: now,
            created_at: now,
            updated_at: now,
          })
          result.linksCreated++
        }
      }
    } else if (integration.kind === 'sonarr') {
      const series = await fetchSeries(integration.base_url, apiKey)
      const limited = series.slice(0, MAX_ITEMS_PER_SYNC)
      result.itemsFetched = limited.length

      const mapped = await mapSonarrSeries(db, limited)
      result.itemsMapped = mapped.length

      for (const { helixItemId, arrSeries } of mapped) {
        mappedHelixIds.push(helixItemId)
        if (!arrSeries) continue
        const externalKind = 'sonarr_series' as const
        const externalId = String(arrSeries.externalId)

        const [existing] = await db
          .select({ id: externalMediaLinks.id })
          .from(externalMediaLinks)
          .where(
            and(
              eq(externalMediaLinks.integration_id, integrationId),
              eq(externalMediaLinks.external_kind, externalKind),
              eq(externalMediaLinks.external_id, externalId)
            )
          )

        if (existing) {
          await db
            .update(externalMediaLinks)
            .set({
              external_title: arrSeries.title,
              monitored: arrSeries.monitored ? 1 : 0,
              quality_profile: arrSeries.qualityProfileName ?? null,
              root_path: arrSeries.path ?? null,
              last_synced_at: now,
              updated_at: now,
            })
            .where(eq(externalMediaLinks.id, existing.id))
          result.linksUpdated++
        } else {
          await db.insert(externalMediaLinks).values({
            id: crypto.randomUUID(),
            media_item_id: helixItemId,
            integration_id: integrationId,
            external_kind: externalKind,
            external_id: externalId,
            external_guid: null,
            external_title: arrSeries.title,
            monitored: arrSeries.monitored ? 1 : 0,
            quality_profile: arrSeries.qualityProfileName ?? null,
            root_path: arrSeries.path ?? null,
            last_synced_at: now,
            created_at: now,
            updated_at: now,
          })
          result.linksCreated++
        }
      }
    } else {
      result.errors.push(`Unsupported integration kind: ${integration.kind}`)
    }
  } catch (err: unknown) {
    result.errors.push(err instanceof Error ? err.message : String(err))
  }

  // Enqueue mapped items for background metadata enrichment
  if (mappedHelixIds.length > 0) {
    enrichmentQueue.enqueue(db, mappedHelixIds).catch(() => {})
  }

  // Update last_synced_at
  await db
    .update(integrations)
    .set({ last_synced_at: now, updated_at: now })
    .where(eq(integrations.id, integrationId))

  return result
}
