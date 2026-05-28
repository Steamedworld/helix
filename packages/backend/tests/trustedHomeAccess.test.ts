/**
 * Trusted Home access workflow tests — Phase N.
 *
 * Covers:
 *
 * Access summary (4 tests):
 *   - Requires admin (401/403 for unauthenticated/normal user)
 *   - Returns only libraries for the specified node (not other nodes')
 *   - Returns grant status per user per library
 *   - Never includes password_hash or token_hash in response
 *
 * Bulk update (5 tests):
 *   - Requires admin
 *   - Rejects libraryId from a different node (403)
 *   - Grants can_view and can_play
 *   - Revoke: canView: false removes access
 *   - Idempotent: applying same grants twice is safe
 *
 * Access enforcement (3 tests):
 *   - Normal user with no grants cannot see remote library
 *   - Normal user with can_view but not can_play sees library but playback is blocked
 *   - Normal user with both grants can view and play
 *
 * Regression (3 tests):
 *   - Existing library permission tests still pass (re-verified via API)
 *   - Trusted Home invite flow still works
 *   - Direct federation health/catalog still works
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { setupAuth } from './helpers/auth'
import { COOKIE_NAME } from '../src/middleware/auth'
import { libraries, mediaItems, mediaVersions, mediaFiles, users, nodes } from '../src/db/schema'
import { hashPassword } from '../src/services/auth/password'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

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

async function createMovieWithFile(
  db: TestDb,
  libraryId: string,
  localNodeId: string,
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
    node_id: localNodeId,
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

// ─── Access Summary tests ─────────────────────────────────────────────────────

describe('Trusted Home access summary', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let remoteNodeId: string
  let remoteLibId: string
  let otherNodeId: string
  let otherLibId: string
  let normalUserId: string
  let normalUserCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-access-summary-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    // Create remote node with a library
    remoteNodeId = await createRemoteNode(db, 'Remote Home A')
    remoteLibId = await createLibrary(db, remoteNodeId, 'Remote Movies', testDir)

    // Create another node with another library (should not appear in remote node's summary)
    otherNodeId = await createRemoteNode(db, 'Other Home')
    otherLibId = await createLibrary(db, otherNodeId, 'Other Library', testDir)

    // Create a normal user
    normalUserId = await createNormalUser(db, 'testuser')
    normalUserCookie = await loginUser(app, 'testuser')

    void otherLibId
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('requires admin — unauthenticated → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/access-summary`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('requires admin — normal user → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/access-summary`,
      headers: { Cookie: normalUserCookie },
    })
    expect(res.statusCode).toBe(403)
  })

  it('returns only libraries for the specified node', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/access-summary`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)

    const libIds = body.data.libraries.map((l: { id: string }) => l.id)
    expect(libIds).toContain(remoteLibId)
    expect(libIds).not.toContain(otherLibId)
    expect(libIds).not.toContain(localNodeId) // local node's libs not included
  })

  it('returns grant status per user per library', async () => {
    // Grant access to the remote library for normalUser
    await app.inject({
      method: 'PUT',
      url: `/api/v1/libraries/${remoteLibId}/permissions/${normalUserId}`,
      headers: { Cookie: adminCookie },
      payload: { can_view: true, can_play: false },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/access-summary`,
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)

    const lib = body.data.libraries.find((l: { id: string }) => l.id === remoteLibId)
    expect(lib).toBeDefined()

    const grant = lib.grants.find((g: { userId: string }) => g.userId === normalUserId)
    expect(grant).toBeDefined()
    expect(grant.canView).toBe(true)
    expect(grant.canPlay).toBe(false)
  })

  it('never includes password_hash or token_hash in response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${remoteNodeId}/access-summary`,
      headers: { Cookie: adminCookie },
    })
    const bodyText = res.body
    expect(bodyText).not.toContain('password_hash')
    expect(bodyText).not.toContain('token_hash')
    expect(bodyText).not.toContain('api_token_encrypted')
  })
})

// ─── Bulk permission update tests ─────────────────────────────────────────────

describe('Trusted Home bulk access update', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let remoteNodeId: string
  let remoteLibId: string
  let otherNodeId: string
  let otherLibId: string
  let normalUserId: string
  let normalUserCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-access-update-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    remoteNodeId = await createRemoteNode(db, 'Remote Home B')
    remoteLibId = await createLibrary(db, remoteNodeId, 'Remote Films', testDir)

    otherNodeId = await createRemoteNode(db, 'Other Home')
    otherLibId = await createLibrary(db, otherNodeId, 'Other Films', testDir)

    normalUserId = await createNormalUser(db, 'user2')
    normalUserCookie = await loginUser(app, 'user2')
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('requires admin — unauthenticated → 401', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      payload: { grants: [{ libraryId: remoteLibId, userId: normalUserId, canView: true, canPlay: true }] },
    })
    expect(res.statusCode).toBe(401)
  })

  it('requires admin — normal user → 403', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: normalUserCookie },
      payload: { grants: [{ libraryId: remoteLibId, userId: normalUserId, canView: true, canPlay: true }] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects libraryId from a different node → 403', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
      payload: {
        grants: [
          // otherLibId belongs to otherNodeId, not remoteNodeId
          { libraryId: otherLibId, userId: normalUserId, canView: true, canPlay: true },
        ],
      },
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
  })

  it('grants can_view and can_play', async () => {
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
    expect(body.data.updated).toBe(true)

    // Verify via library permissions route
    const permRes = await app.inject({
      method: 'GET',
      url: `/api/v1/libraries/${remoteLibId}/permissions`,
      headers: { Cookie: adminCookie },
    })
    const permBody = JSON.parse(permRes.body)
    const perm = permBody.data.find((p: { user_id: string }) => p.user_id === normalUserId)
    expect(perm).toBeDefined()
    expect(perm.can_view).toBe(true)
    expect(perm.can_play).toBe(true)
  })

  it('revoke: canView false removes access', async () => {
    // First grant
    await app.inject({
      method: 'PUT',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
      payload: {
        grants: [{ libraryId: remoteLibId, userId: normalUserId, canView: true, canPlay: true }],
      },
    })

    // Then revoke
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
      payload: {
        grants: [{ libraryId: remoteLibId, userId: normalUserId, canView: false, canPlay: false }],
      },
    })
    expect(res.statusCode).toBe(200)

    // Verify revoked
    const permRes = await app.inject({
      method: 'GET',
      url: `/api/v1/libraries/${remoteLibId}/permissions`,
      headers: { Cookie: adminCookie },
    })
    const permBody = JSON.parse(permRes.body)
    const perm = permBody.data.find((p: { user_id: string }) => p.user_id === normalUserId)
    // Permission row may exist but both flags should be false
    if (perm) {
      expect(perm.can_view).toBe(false)
      expect(perm.can_play).toBe(false)
    }
    // Also verify user cannot view the library via the library list
    const libRes = await app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: { Cookie: normalUserCookie },
    })
    const libBody = JSON.parse(libRes.body)
    expect(libBody.data.find((l: { id: string }) => l.id === remoteLibId)).toBeUndefined()
  })

  it('idempotent: applying same grants twice is safe', async () => {
    const payload = {
      grants: [{ libraryId: remoteLibId, userId: normalUserId, canView: true, canPlay: true }],
    }

    const first = await app.inject({
      method: 'PUT',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
      payload,
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'PUT',
      url: `/api/v1/nodes/${remoteNodeId}/access`,
      headers: { Cookie: adminCookie },
      payload,
    })
    expect(second.statusCode).toBe(200)
    const body = JSON.parse(second.body)
    expect(body.ok).toBe(true)
    expect(body.data.updated).toBe(true)

    // Still exactly one permission row
    const permRes = await app.inject({
      method: 'GET',
      url: `/api/v1/libraries/${remoteLibId}/permissions`,
      headers: { Cookie: adminCookie },
    })
    const permBody = JSON.parse(permRes.body)
    const userPerms = permBody.data.filter((p: { user_id: string }) => p.user_id === normalUserId)
    expect(userPerms.length).toBe(1)
  })
})

// ─── Access enforcement tests ─────────────────────────────────────────────────

describe('Trusted Home access enforcement (remote library)', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let remoteNodeId: string
  let remoteLibId: string
  let normalUserId: string
  let normalUserCookie: string
  let mediaItemId: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-access-enforce-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    remoteNodeId = await createRemoteNode(db, 'Remote Home C')
    remoteLibId = await createLibrary(db, remoteNodeId, 'Remote TV', testDir, 'tv')

    // Create a movie in the remote library with a real file
    const filePath = join(testDir, 'remote-movie.mp4')
    const result = await createMovieWithFile(db, remoteLibId, localNodeId, 'Remote Movie', filePath)
    mediaItemId = result.mediaItemId

    normalUserId = await createNormalUser(db, 'user3')
    normalUserCookie = await loginUser(app, 'user3')
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('normal user with no grants cannot see remote library', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: { Cookie: normalUserCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.find((l: { id: string }) => l.id === remoteLibId)).toBeUndefined()
  })

  it('normal user with can_view but not can_play sees library but playback is blocked', async () => {
    // Grant can_view only
    await app.inject({
      method: 'PUT',
      url: `/api/v1/libraries/${remoteLibId}/permissions/${normalUserId}`,
      headers: { Cookie: adminCookie },
      payload: { can_view: true, can_play: false },
    })

    // User can see the library
    const libRes = await app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: { Cookie: normalUserCookie },
    })
    const libBody = JSON.parse(libRes.body)
    expect(libBody.data.find((l: { id: string }) => l.id === remoteLibId)).toBeDefined()

    // User can see media detail
    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}`,
      headers: { Cookie: normalUserCookie },
    })
    expect(detailRes.statusCode).toBe(200)

    // But playback-source is blocked
    const playRes = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: normalUserCookie },
    })
    expect(playRes.statusCode).toBe(403)
  })

  it('normal user with both grants can view and play', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/v1/libraries/${remoteLibId}/permissions/${normalUserId}`,
      headers: { Cookie: adminCookie },
      payload: { can_view: true, can_play: true },
    })

    // Library visible
    const libRes = await app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: { Cookie: normalUserCookie },
    })
    const libBody = JSON.parse(libRes.body)
    expect(libBody.data.find((l: { id: string }) => l.id === remoteLibId)).toBeDefined()

    // Media detail accessible
    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}`,
      headers: { Cookie: normalUserCookie },
    })
    expect(detailRes.statusCode).toBe(200)

    // Playback-source accessible (returns signed URL)
    const playRes = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaItemId}/playback-source`,
      headers: { Cookie: normalUserCookie },
    })
    expect(playRes.statusCode).toBe(200)
    const playBody = JSON.parse(playRes.body)
    expect(playBody.data.source).toBeDefined()
    expect(playBody.data.source.streamUrl).toContain('?token=')
  })
})

// ─── Regression tests ─────────────────────────────────────────────────────────

describe('Trusted Home access — regression', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string
  let rawFedToken: string
  let localLibId: string
  let normalUserId: string
  let normalUserCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-access-regression-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, 'http://helix.example.com', testDir)
    await app.ready()
    adminCookie = await setupAuth(app)

    // Set up federation token
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/federation/token',
      headers: { Cookie: adminCookie },
    })
    rawFedToken = JSON.parse(tokenRes.body).data.token

    localLibId = await createLibrary(db, localNodeId, 'Local Movies', testDir)
    normalUserId = await createNormalUser(db, 'reguser')
    normalUserCookie = await loginUser(app, 'reguser')
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('existing library permission grant/revoke still works', async () => {
    // Grant
    const grantRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/libraries/${localLibId}/permissions/${normalUserId}`,
      headers: { Cookie: adminCookie },
      payload: { can_view: true, can_play: true },
    })
    expect(grantRes.statusCode).toBe(200)

    // User can see library
    const libRes = await app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: { Cookie: normalUserCookie },
    })
    const libBody = JSON.parse(libRes.body)
    expect(libBody.data).toHaveLength(1)

    // Revoke
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/libraries/${localLibId}/permissions/${normalUserId}`,
      headers: { Cookie: adminCookie },
    })

    const afterRes = await app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: { Cookie: normalUserCookie },
    })
    expect(JSON.parse(afterRes.body).data).toHaveLength(0)
  })

  it('trusted home invite creation still works', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trusted-home-invites',
      headers: { Cookie: adminCookie },
      payload: { label: 'Regression test invite' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(typeof body.data.invite.token).toBe('string')
  })

  it('direct federation health still works', async () => {
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
