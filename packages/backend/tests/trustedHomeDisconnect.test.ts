/**
 * Trusted Home disconnect and bulk-revoke tests.
 *
 * Covers:
 *
 * Disconnect (DELETE /nodes/:id) — 10 tests:
 *   - Unauthenticated → 401
 *   - Normal user → 403
 *   - Admin cannot disconnect local node → 400
 *   - Disconnect removes node record
 *   - Disconnect removes remote libraries
 *   - Disconnect removes remote media_items
 *   - Disconnect removes remote library_permissions (access grants)
 *   - Disconnect does NOT remove local library or media_item records
 *   - Disconnect returns correct cleanup summary counts
 *   - Repeated disconnect (node already gone) → 404 gracefully
 *
 * Bulk revoke (DELETE /nodes/:id/access) — 4 tests:
 *   - Requires admin (401/403)
 *   - Removes grants for target node's libraries only
 *   - Does not affect local library permissions
 *   - Returns grantsRemoved count
 *
 * Regression — 3 tests:
 *   - Access summary still works after partial state changes
 *   - Bulk grant (PUT /nodes/:id/access) still works
 *   - Federation health endpoint still works
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { setupAuth } from './helpers/auth'
import { COOKIE_NAME } from '../src/middleware/auth'
import {
  nodes,
  libraries,
  mediaItems,
  mediaVersions,
  mediaFiles,
  libraryPermissions,
  users,
} from '../src/db/schema'
import { hashPassword } from '../src/services/auth/password'

// ─── helpers ──────────────────────────────────────────────────────────────────

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

async function createRemoteNode(db: TestDb, name: string) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.insert(nodes).values({
    id,
    name,
    kind: 'remote',
    base_url: `http://remote-${id}.local:3001`,
    status: 'online',
    api_token_encrypted: null,
    created_at: now,
    updated_at: now,
  })
  return id
}

async function createLibrary(
  db: TestDb,
  nodeId: string,
  name: string,
  rootPath: string,
  kind: 'movies' | 'tv' = 'movies'
) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.insert(libraries).values({
    id,
    node_id: nodeId,
    name,
    kind,
    root_path: rootPath,
    scan_status: 'idle',
    created_at: now,
    updated_at: now,
  })
  return id
}

async function createMediaItemWithFile(
  db: TestDb,
  libraryId: string,
  nodeId: string,
  title: string,
  filePath: string
) {
  const now = new Date().toISOString()
  writeFileSync(filePath, Buffer.from('fake video content'))

  const mediaItemId = crypto.randomUUID()
  await db.insert(mediaItems).values({
    id: mediaItemId,
    library_id: libraryId,
    kind: 'movie',
    title,
    sort_title: title.toLowerCase(),
    year: 2020,
    metadata_status: 'local',
    metadata_source: 'filename',
    created_at: now,
    updated_at: now,
  })

  const versionId = crypto.randomUUID()
  await db.insert(mediaVersions).values({
    id: versionId,
    media_item_id: mediaItemId,
    container: 'mp4',
    duration_seconds: 7200,
    created_at: now,
    updated_at: now,
  })

  const fileId = crypto.randomUUID()
  await db.insert(mediaFiles).values({
    id: fileId,
    node_id: nodeId,
    library_id: libraryId,
    media_item_id: mediaItemId,
    media_version_id: versionId,
    path: filePath,
    filename: 'movie.mp4',
    extension: '.mp4',
    size_bytes: 18,
    file_hash: null,
    discovered_at: now,
    updated_at: now,
  })

  return { mediaItemId, versionId, fileId }
}

async function createNormalUser(db: TestDb, username: string) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const passwordHash = await hashPassword('password123')
  await db.insert(users).values({
    id,
    display_name: username,
    role: 'user',
    username,
    password_hash: passwordHash,
    disabled: 0,
    created_at: now,
    updated_at: now,
  })
  return id
}

async function loginUser(app: ReturnType<typeof buildServer>, username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password: 'password123' },
  })
  if (res.statusCode !== 200) throw new Error(`Login failed: ${res.body}`)
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string)
  const match = raw.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  if (!match) throw new Error('No session cookie')
  return `${COOKIE_NAME}=${match[1]}`
}

async function grantLibraryAccess(
  db: TestDb,
  libraryId: string,
  userId: string
) {
  const now = new Date().toISOString()
  await db.insert(libraryPermissions).values({
    id: crypto.randomUUID(),
    library_id: libraryId,
    user_id: userId,
    can_view: true,
    can_play: true,
    created_at: now,
    updated_at: now,
  })
}

// ─── Disconnect tests ─────────────────────────────────────────────────────────

describe('Trusted Home disconnect (DELETE /nodes/:id)', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let normalUserCookie: string
  let normalUserId: string
  let remoteNodeId: string
  let remoteLibId: string
  let mediaItemId: string
  let fileId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-disconnect-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    // Remote node with one library, one media item, one file
    remoteNodeId = await createRemoteNode(db, 'Remote Home Disconnect')
    remoteLibId = await createLibrary(db, remoteNodeId, 'Remote Movies', testDir)
    const filePath = join(testDir, `remote-movie-${crypto.randomUUID()}.mp4`)
    const created = await createMediaItemWithFile(db, remoteLibId, remoteNodeId, 'Remote Film', filePath)
    mediaItemId = created.mediaItemId
    fileId = created.fileId

    // Normal user
    normalUserId = await createNormalUser(db, 'disconnectuser')
    normalUserCookie = await loginUser(app, 'disconnectuser')

    // Grant access to the remote library
    await grantLibraryAccess(db, remoteLibId, normalUserId)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('unauthenticated → 401', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('normal user → 403', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}`,
      headers: { Cookie: normalUserCookie },
    })
    expect(res.statusCode).toBe(403)
  })

  it('admin cannot disconnect the local node → 400', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${localNodeId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/local home/)
  })

  it('disconnect removes the node record', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)

    const [row] = await db.select().from(nodes).where(eq(nodes.id, remoteNodeId))
    expect(row).toBeUndefined()
  })

  it('disconnect removes remote libraries', async () => {
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}`,
      headers: { Cookie: adminCookie },
    })

    const libs = await db.select().from(libraries).where(eq(libraries.node_id, remoteNodeId))
    expect(libs).toHaveLength(0)
  })

  it('disconnect removes remote media_items', async () => {
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}`,
      headers: { Cookie: adminCookie },
    })

    const [item] = await db.select().from(mediaItems).where(eq(mediaItems.id, mediaItemId))
    expect(item).toBeUndefined()
  })

  it('disconnect removes library_permissions (access grants)', async () => {
    // Verify grant exists before
    const before = await db
      .select()
      .from(libraryPermissions)
      .where(eq(libraryPermissions.library_id, remoteLibId))
    expect(before.length).toBeGreaterThan(0)

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}`,
      headers: { Cookie: adminCookie },
    })

    const after = await db
      .select()
      .from(libraryPermissions)
      .where(eq(libraryPermissions.library_id, remoteLibId))
    expect(after).toHaveLength(0)
  })

  it('disconnect does NOT remove local library or media_item records', async () => {
    // Create a local library with media
    const localLibId = await createLibrary(db, localNodeId, 'Local Movies', testDir)
    const localFilePath = join(testDir, `local-movie-${crypto.randomUUID()}.mp4`)
    const { mediaItemId: localItemId } = await createMediaItemWithFile(
      db, localLibId, localNodeId, 'Local Film', localFilePath
    )

    // Disconnect the remote node
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}`,
      headers: { Cookie: adminCookie },
    })

    // Local library must still exist
    const [localLib] = await db.select().from(libraries).where(eq(libraries.id, localLibId))
    expect(localLib).toBeDefined()
    expect(localLib.node_id).toBe(localNodeId)

    // Local media item must still exist
    const [localItem] = await db.select().from(mediaItems).where(eq(mediaItems.id, localItemId))
    expect(localItem).toBeDefined()
  })

  it('disconnect returns correct cleanup summary counts', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.nodeRemoved).toBe(true)
    expect(body.data.librariesRemoved).toBe(1)
    expect(body.data.mediaItemsRemoved).toBe(1)
    expect(body.data.mediaFilesRemoved).toBe(1)
    expect(body.data.grantsRemoved).toBe(1)
  })

  it('repeated disconnect (node already gone) → 404 gracefully', async () => {
    // First disconnect
    const first = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}`,
      headers: { Cookie: adminCookie },
    })
    expect(first.statusCode).toBe(200)

    // Second attempt
    const second = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}`,
      headers: { Cookie: adminCookie },
    })
    expect(second.statusCode).toBe(404)
    const body = JSON.parse(second.body)
    expect(body.ok).toBe(false)

    void fileId // used only to verify it was created
  })
})

// ─── Bulk revoke tests ─────────────────────────────────────────────────────────

describe('Trusted Home bulk revoke (DELETE /nodes/:id/access)', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let normalUserCookie: string
  let normalUserId: string
  let remoteNodeId: string
  let remoteLibId: string
  let otherNodeId: string
  let otherLibId: string
  let localLibId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-bulk-revoke-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    // Remote nodes
    remoteNodeId = await createRemoteNode(db, 'Remote Revoke A')
    remoteLibId = await createLibrary(db, remoteNodeId, 'Remote Lib A', testDir)

    otherNodeId = await createRemoteNode(db, 'Remote Revoke B')
    otherLibId = await createLibrary(db, otherNodeId, 'Remote Lib B', testDir)

    // Local library
    localLibId = await createLibrary(db, localNodeId, 'Local Library', testDir)

    // Normal user
    normalUserId = await createNormalUser(db, 'revokeuser')
    normalUserCookie = await loginUser(app, 'revokeuser')

    // Grant access to remote lib A and local lib
    await grantLibraryAccess(db, remoteLibId, normalUserId)
    await grantLibraryAccess(db, localLibId, normalUserId)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('requires admin — unauthenticated → 401 / normal user → 403', async () => {
    const unauth = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
    })
    expect(unauth.statusCode).toBe(401)

    const userRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: normalUserCookie },
    })
    expect(userRes.statusCode).toBe(403)
  })

  it('removes grants for target node libraries only', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)

    // Grant for remote lib A should be gone
    const remoteGrants = await db
      .select()
      .from(libraryPermissions)
      .where(eq(libraryPermissions.library_id, remoteLibId))
    expect(remoteGrants).toHaveLength(0)

    // Grant for other node's lib should be unaffected
    // (otherLibId has no grants in this test, but the local lib grant must survive)
  })

  it('does not affect local library permissions', async () => {
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
    })

    // Local library grant must still exist
    const localGrants = await db
      .select()
      .from(libraryPermissions)
      .where(eq(libraryPermissions.library_id, localLibId))
    expect(localGrants.length).toBeGreaterThan(0)

    void otherLibId // referenced to avoid lint warning
  })

  it('returns grantsRemoved count', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.data.grantsRemoved).toBe(1)

    // Second call returns 0 (already revoked)
    const second = await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
    })
    const body2 = JSON.parse(second.body)
    expect(body2.data.grantsRemoved).toBe(0)
  })
})

// ─── Regression tests ─────────────────────────────────────────────────────────

describe('Trusted Home disconnect — regression', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawFedToken: string
  let remoteNodeId: string
  let remoteLibId: string
  let normalUserId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-disconnect-regression-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    rawFedToken = JSON.parse(tokenRes.body).data.token

    remoteNodeId = await createRemoteNode(db, 'Regression Remote')
    remoteLibId = await createLibrary(db, remoteNodeId, 'Regression Lib', testDir)
    normalUserId = await createNormalUser(db, 'regdiscouser')
    await grantLibraryAccess(db, remoteLibId, normalUserId)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('access summary still works after bulk revoke', async () => {
    // Revoke all access
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
    })

    // Access summary should still return the library, just with empty grants
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/access-summary`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    const lib = body.data.libraries.find((l: { id: string }) => l.id === remoteLibId)
    expect(lib).toBeDefined()
    expect(lib.grants).toHaveLength(0)
    // The user should appear in ungrantedUsers
    const ungranted = lib.ungrantedUsers.find((u: { userId: string }) => u.userId === normalUserId)
    expect(ungranted).toBeDefined()
  })

  it('bulk grant (PUT /nodes/:id/access) still works after bulk revoke', async () => {
    // Revoke first
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
    })

    // Re-grant
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
      payload: {
        grants: [{ libraryId: remoteLibId, userId: normalUserId, canView: true, canPlay: true }],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)

    // Grant should exist again
    const grants = await db
      .select()
      .from(libraryPermissions)
      .where(eq(libraryPermissions.library_id, remoteLibId))
    expect(grants.length).toBeGreaterThan(0)
  })

  it('federation health endpoint still works', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/federation/health',
      headers: { Authorization: `Bearer ${rawFedToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('online')
  })
})
