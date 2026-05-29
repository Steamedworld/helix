import type { DrizzleDB } from '../../db/client'
import { libraries, mediaItems, mediaVersions, mediaFiles } from '../../db/schema'
import { decryptApiKey } from '../integrations/encryption'

// ─── Wire-format types ────────────────────────────────────────────────────────

export interface FederationCatalogLibrary {
  id: string
  name: string
  kind: string
  itemCount: number
}

export interface FederationCatalogItem {
  id: string
  library_id: string
  parent_id: string | null
  kind: string
  title: string
  sort_title: string | null
  year: number | null
  overview: string | null
  has_poster: boolean
  has_backdrop: boolean
  original_title: string | null
  release_date: string | null
  content_rating: string | null
  runtime_seconds: number | null
  season_number: number | null
  episode_number: number | null
  episode_title: string | null
  absolute_episode_number: number | null
  metadata_status: string
  external_tmdb_id: string | null
  external_tvdb_id: string | null
  updated_at: string
}

export interface FederationCatalogVersion {
  id: string
  media_item_id: string
  label: string | null
  quality_label: string | null
  resolution_width: number | null
  resolution_height: number | null
  video_codec: string | null
  audio_codec: string | null
  container: string | null
  duration_seconds: number | null
}

export interface FederationCatalogFile {
  id: string
  media_item_id: string
  media_version_id: string
  filename: string
  extension: string
  size_bytes: number | null
}

export interface FederationCatalogData {
  nodeId: string
  nodeName: string
  exportedAt: number
  /** Present when the response was produced with a ?since filter */
  incremental?: boolean
  /** The ISO8601 since timestamp used to produce this incremental response */
  since?: string
  libraries: FederationCatalogLibrary[]
  items: FederationCatalogItem[]
  versions: FederationCatalogVersion[]
  files: FederationCatalogFile[]
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

export async function fetchRemoteCatalog(
  baseUrl: string,
  rawToken: string,
  sinceIso?: string
): Promise<FederationCatalogData> {
  const url = sinceIso
    ? `${baseUrl}/api/v1/federation/catalog?since=${encodeURIComponent(sinceIso)}`
    : `${baseUrl}/api/v1/federation/catalog`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${rawToken}` },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Remote catalog fetch failed: HTTP ${res.status} ${text}`)
  }
  const json = (await res.json()) as { ok: boolean; data: FederationCatalogData; error?: string }
  if (!json.ok) throw new Error(json.error ?? 'Remote catalog error')
  return json.data
}

// ─── Import ───────────────────────────────────────────────────────────────────

export async function importCatalog(
  nodeId: string,
  catalog: FederationCatalogData,
  db: DrizzleDB
): Promise<{ librariesSynced: number; itemsSynced: number }> {
  const now = new Date().toISOString()
  const remoteRootPath = `remote://${nodeId}`

  // Build item→library map for file upsert
  const itemLibraryMap = new Map(catalog.items.map((i) => [i.id, i.library_id]))

  // Upsert libraries
  for (const lib of catalog.libraries) {
    await db
      .insert(libraries)
      .values({
        id: lib.id,
        node_id: nodeId,
        name: lib.name,
        kind: lib.kind as (typeof libraries.$inferInsert)['kind'],
        root_path: remoteRootPath,
        scan_status: 'idle',
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: libraries.id,
        set: { name: lib.name, updated_at: now },
      })
  }

  // Upsert media items
  for (const item of catalog.items) {
    await db
      .insert(mediaItems)
      .values({
        id: item.id,
        library_id: item.library_id,
        parent_id: item.parent_id,
        kind: item.kind as (typeof mediaItems.$inferInsert)['kind'],
        title: item.title,
        sort_title: item.sort_title,
        year: item.year,
        overview: item.overview,
        poster_path: item.has_poster ? `remote-artwork://${nodeId}` : null,
        backdrop_path: item.has_backdrop ? `remote-artwork://${nodeId}` : null,
        original_title: item.original_title,
        release_date: item.release_date,
        content_rating: item.content_rating,
        runtime_seconds: item.runtime_seconds,
        season_number: item.season_number,
        episode_number: item.episode_number,
        episode_title: item.episode_title,
        absolute_episode_number: item.absolute_episode_number,
        metadata_status: item.metadata_status as (typeof mediaItems.$inferInsert)['metadata_status'],
        metadata_source: 'federation',
        metadata_updated_at: Date.now(),
        external_tmdb_id: item.external_tmdb_id,
        external_tvdb_id: item.external_tvdb_id,
        external_musicbrainz_id: null,
        created_at: item.updated_at,
        updated_at: item.updated_at,
      })
      .onConflictDoUpdate({
        target: mediaItems.id,
        set: {
          title: item.title,
          sort_title: item.sort_title,
          year: item.year,
          overview: item.overview,
          poster_path: item.has_poster ? `remote-artwork://${nodeId}` : null,
          backdrop_path: item.has_backdrop ? `remote-artwork://${nodeId}` : null,
          updated_at: item.updated_at,
        },
      })
  }

  // Upsert versions
  for (const version of catalog.versions) {
    await db
      .insert(mediaVersions)
      .values({
        id: version.id,
        media_item_id: version.media_item_id,
        label: version.label,
        quality_label: version.quality_label,
        resolution_width: version.resolution_width,
        resolution_height: version.resolution_height,
        video_codec: version.video_codec,
        audio_codec: version.audio_codec,
        container: version.container,
        duration_seconds: version.duration_seconds,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: mediaVersions.id,
        set: {
          quality_label: version.quality_label,
          resolution_width: version.resolution_width,
          resolution_height: version.resolution_height,
          updated_at: now,
        },
      })
  }

  // Upsert files with sentinel paths
  const fallbackLibraryId = catalog.libraries[0]?.id ?? ''
  for (const file of catalog.files) {
    const sentinelPath = `remote://${nodeId}/${file.id}`
    const libraryId = itemLibraryMap.get(file.media_item_id) ?? fallbackLibraryId
    await db
      .insert(mediaFiles)
      .values({
        id: file.id,
        node_id: nodeId,
        library_id: libraryId,
        media_item_id: file.media_item_id,
        media_version_id: file.media_version_id,
        path: sentinelPath,
        filename: file.filename,
        extension: file.extension,
        size_bytes: file.size_bytes,
        file_hash: null,
        missing_at: null,
        discovered_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: mediaFiles.id,
        set: {
          filename: file.filename,
          size_bytes: file.size_bytes,
          updated_at: now,
        },
      })
  }

  return {
    librariesSynced: catalog.libraries.length,
    itemsSynced: catalog.items.length,
  }
}

// ─── Sync entry point ─────────────────────────────────────────────────────────

export interface SyncRemoteNodeResult {
  fullSync: boolean
  incremental: boolean
  sinceUsed: string | null
  itemsSynced: number
  librariesSynced: number
  fallbackUsed: boolean
}

/**
 * Sync a remote node's catalog.
 *
 * Decision logic:
 *   - If lastSyncAt is null or force=true → full sync (no ?since)
 *   - If lastSyncAt is set → incremental sync with ?since=<lastSyncAt as ISO>
 *       - If remote returns 400 (does not support ?since) → fall back to full sync, warn
 *       - Any other error → propagate (do NOT silently fall back)
 *
 * Incremental sync upserts only returned items — does NOT delete absent items.
 * A full sync (force=true or first sync) reconciles stale/deleted records.
 */
export async function syncRemoteNode(
  nodeId: string,
  baseUrl: string,
  apiTokenEncrypted: string,
  dataDir: string,
  db: DrizzleDB,
  opts?: { lastSyncAt?: number | null; force?: boolean }
): Promise<SyncRemoteNodeResult> {
  const rawToken = decryptApiKey(apiTokenEncrypted, dataDir)
  const { lastSyncAt, force } = opts ?? {}

  // Determine whether to attempt incremental sync
  const attemptIncremental = !force && lastSyncAt != null
  const sinceIso = attemptIncremental ? new Date(lastSyncAt!).toISOString() : undefined

  let catalog: FederationCatalogData
  let fallbackUsed = false

  if (attemptIncremental) {
    // Try incremental first
    let incRes: Response | null = null
    try {
      const url = `${baseUrl}/api/v1/federation/catalog?since=${encodeURIComponent(sinceIso!)}`
      incRes = await fetch(url, {
        headers: { Authorization: `Bearer ${rawToken}` },
        signal: AbortSignal.timeout(30000),
      })
    } catch (e) {
      // Network-level failure — propagate
      throw e
    }

    if (incRes.status === 400) {
      // Remote does not support ?since — fall back to full sync
      console.warn(`[catalogSync] Remote node ${nodeId} returned 400 for ?since — falling back to full sync`)
      fallbackUsed = true
      catalog = await fetchRemoteCatalog(baseUrl, rawToken)
    } else if (!incRes.ok) {
      const text = await incRes.text().catch(() => '')
      throw new Error(`Remote catalog fetch failed: HTTP ${incRes.status} ${text}`)
    } else {
      const json = (await incRes.json()) as { ok: boolean; data: FederationCatalogData; error?: string }
      if (!json.ok) throw new Error(json.error ?? 'Remote catalog error')
      catalog = json.data
    }
  } else {
    // Full sync
    catalog = await fetchRemoteCatalog(baseUrl, rawToken)
  }

  const importResult = await importCatalog(nodeId, catalog, db)

  const isIncremental = (attemptIncremental && !fallbackUsed)

  return {
    fullSync: !isIncremental,
    incremental: isIncremental,
    sinceUsed: isIncremental ? (sinceIso ?? null) : null,
    itemsSynced: importResult.itemsSynced,
    librariesSynced: importResult.librariesSynced,
    fallbackUsed,
  }
}

// ─── Backward-compat stubs ────────────────────────────────────────────────────

export async function pushCatalogUpdate(_items: unknown[]): Promise<void> {}
export async function pullCatalogUpdates(_nodeId: string): Promise<unknown[]> {
  return []
}
