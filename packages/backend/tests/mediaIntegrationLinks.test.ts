/**
 * Tests that media/show detail endpoints include integrationLinks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { libraries, mediaItems, integrations, externalMediaLinks } from '../src/db/schema'
import { setupAuth } from './helpers/auth'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

describe('media/show integration links in detail endpoints', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let libraryId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-media-links-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    libraryId = crypto.randomUUID()
    const now = new Date().toISOString()
    await db.insert(libraries).values({
      id: libraryId,
      node_id: localNodeId,
      name: 'Movies',
      kind: 'movies',
      root_path: '/tmp/movies',
      scan_status: 'idle',
      created_at: now,
      updated_at: now,
    })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('movie detail includes integrationLinks when mapped', async () => {
    const movieId = crypto.randomUUID()
    const now = new Date().toISOString()
    await db.insert(mediaItems).values({
      id: movieId,
      library_id: libraryId,
      kind: 'movie',
      title: 'Inception',
      sort_title: 'inception',
      year: 2010,
      metadata_status: 'matched',
      metadata_source: 'tmdb',
      external_tmdb_id: '27205',
      created_at: now,
      updated_at: now,
    })

    // Create a radarr integration
    const integrationId = crypto.randomUUID()
    const ts = Date.now()
    await db.insert(integrations).values({
      id: integrationId,
      kind: 'radarr',
      name: 'My Radarr',
      base_url: 'http://localhost:7878',
      api_key_encrypted: 'dummy:dummy:dummy',
      enabled: 1,
      status: 'online',
      created_at: ts,
      updated_at: ts,
    })

    // Create a link
    const linkId = crypto.randomUUID()
    await db.insert(externalMediaLinks).values({
      id: linkId,
      media_item_id: movieId,
      integration_id: integrationId,
      external_kind: 'radarr_movie',
      external_id: '42',
      external_title: 'Inception',
      monitored: 1,
      quality_profile: 'HD-1080p',
      root_path: '/movies',
      last_synced_at: ts,
      created_at: ts,
      updated_at: ts,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${movieId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.integrationLinks).toBeDefined()
    expect(Array.isArray(body.data.integrationLinks)).toBe(true)
    expect(body.data.integrationLinks).toHaveLength(1)
    const link = body.data.integrationLinks[0]
    expect(link.kind).toBe('radarr')
    expect(link.integrationName).toBe('My Radarr')
    expect(link.monitored).toBe(true)
    expect(link.qualityProfile).toBe('HD-1080p')
    expect(link.externalTitle).toBe('Inception')
  })

  it('show detail includes integrationLinks when mapped', async () => {
    const showId = crypto.randomUUID()
    const now = new Date().toISOString()
    await db.insert(mediaItems).values({
      id: showId,
      library_id: libraryId,
      kind: 'show',
      title: 'Breaking Bad',
      sort_title: 'breaking bad',
      year: 2008,
      metadata_status: 'matched',
      metadata_source: 'tmdb',
      created_at: now,
      updated_at: now,
    })

    const integrationId = crypto.randomUUID()
    const ts = Date.now()
    await db.insert(integrations).values({
      id: integrationId,
      kind: 'sonarr',
      name: 'My Sonarr',
      base_url: 'http://localhost:8989',
      api_key_encrypted: 'dummy:dummy:dummy',
      enabled: 1,
      status: 'online',
      created_at: ts,
      updated_at: ts,
    })

    const linkId = crypto.randomUUID()
    await db.insert(externalMediaLinks).values({
      id: linkId,
      media_item_id: showId,
      integration_id: integrationId,
      external_kind: 'sonarr_series',
      external_id: '1',
      external_title: 'Breaking Bad',
      monitored: 1,
      quality_profile: 'WEB-DL 1080p',
      root_path: '/tv',
      last_synced_at: ts,
      created_at: ts,
      updated_at: ts,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/shows/${showId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.integrationLinks).toBeDefined()
    expect(body.data.integrationLinks).toHaveLength(1)
    const link = body.data.integrationLinks[0]
    expect(link.kind).toBe('sonarr')
    expect(link.integrationName).toBe('My Sonarr')
    expect(link.monitored).toBe(true)
    expect(link.qualityProfile).toBe('WEB-DL 1080p')
  })

  it('integrationLinks is empty when no mapping', async () => {
    const movieId = crypto.randomUUID()
    const now = new Date().toISOString()
    await db.insert(mediaItems).values({
      id: movieId,
      library_id: libraryId,
      kind: 'movie',
      title: 'Unmapped Movie',
      sort_title: 'unmapped movie',
      year: 2015,
      metadata_status: 'local',
      metadata_source: 'filename',
      created_at: now,
      updated_at: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${movieId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.integrationLinks).toBeDefined()
    expect(body.data.integrationLinks).toHaveLength(0)
  })
})
