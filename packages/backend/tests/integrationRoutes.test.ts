/**
 * Integration API route tests — admin-only endpoints.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { COOKIE_NAME } from '../src/middleware/auth'
import { setupAuth } from './helpers/auth'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

function extractCookie(setCookieHeader: string | string[] | undefined): string | null {
  if (!setCookieHeader) return null
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader
  const match = raw.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  return match ? `${COOKIE_NAME}=${match[1]}` : null
}

describe('integration routes', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-int-routes-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    rmSync(testDir, { recursive: true, force: true })
  })

  // ─── Admin: CRUD ─────────────────────────────────────────────────────────────

  it('admin: create integration → 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: {
        kind: 'radarr',
        name: 'My Radarr',
        baseUrl: 'http://localhost:7878',
        apiKey: 'abc123keytest',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.kind).toBe('radarr')
    expect(body.data.name).toBe('My Radarr')
    // Should NOT contain plaintext API key
    expect(body.data.apiKeyMasked).toBeDefined()
    expect(body.data.apiKeyMasked).not.toBe('abc123keytest')
    expect(body.data.apiKey).toBeUndefined()
    expect(body.data.apiKeyEncrypted).toBeUndefined()
    expect(body.data.api_key_encrypted).toBeUndefined()
  })

  it('admin: list integrations — API key masked', async () => {
    // Create one first
    await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: { kind: 'sonarr', name: 'Sonarr', baseUrl: 'http://localhost:8989', apiKey: 'mysecretkey9999' },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.length).toBeGreaterThan(0)
    const integration = body.data[0]
    expect(integration.apiKeyMasked).toBeDefined()
    expect(integration.apiKeyMasked).not.toBe('mysecretkey9999')
    expect(integration.apiKey).toBeUndefined()
  })

  it('admin: get integration — API key masked', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: { kind: 'radarr', name: 'Radarr', baseUrl: 'http://localhost:7878', apiKey: 'plainkey1234' },
    })
    const { id } = JSON.parse(createRes.body).data

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/${id}`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.apiKeyMasked).toBeDefined()
    expect(body.data.apiKeyMasked).not.toBe('plainkey1234')
  })

  it('admin: update integration', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: { kind: 'radarr', name: 'Old Name', baseUrl: 'http://localhost:7878', apiKey: 'oldkey' },
    })
    const { id } = JSON.parse(createRes.body).data

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${id}`,
      headers: { Cookie: adminCookie },
      payload: { name: 'New Name', enabled: false },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.name).toBe('New Name')
    expect(body.data.enabled).toBe(false)
  })

  it('admin: delete integration removes links', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: { kind: 'radarr', name: 'To Delete', baseUrl: 'http://localhost:7878', apiKey: 'key123' },
    })
    const { id } = JSON.parse(createRes.body).data

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/integrations/${id}`,
      headers: { Cookie: adminCookie },
    })
    expect(delRes.statusCode).toBe(200)
    const body = JSON.parse(delRes.body)
    expect(body.data.deleted).toBe(true)

    // Confirm it's gone
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/${id}`,
      headers: { Cookie: adminCookie },
    })
    expect(getRes.statusCode).toBe(404)
  })

  it('admin: test connection (mocked Radarr)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version: '5.0.0' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: { kind: 'radarr', name: 'Radarr', baseUrl: 'http://localhost:7878', apiKey: 'testkey' },
    })
    const { id } = JSON.parse(createRes.body).data

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/test`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.testResult.ok).toBe(true)
    expect(body.data.testResult.version).toBe('5.0.0')
    expect(body.data.integration.status).toBe('online')
  })

  it('admin: sync (mocked Radarr, creates links)', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    // No movies
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    })

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: { kind: 'radarr', name: 'Radarr', baseUrl: 'http://localhost:7878', apiKey: 'testkey' },
    })
    const { id } = JSON.parse(createRes.body).data

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/sync`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.itemsFetched).toBe(0)
    expect(body.data.linksCreated).toBe(0)
    expect(body.data.errors).toHaveLength(0)
  })

  it('admin: list items for integration', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: { kind: 'radarr', name: 'Radarr', baseUrl: 'http://localhost:7878', apiKey: 'testkey' },
    })
    const { id } = JSON.parse(createRes.body).data

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/${id}/items`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(Array.isArray(body.data)).toBe(true)
  })

  // ─── Authorization tests ──────────────────────────────────────────────────────

  it('normal user: create integration → 403', async () => {
    // Create a non-admin user
    await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { Cookie: adminCookie },
      payload: { username: 'normaluser', password: 'password123', role: 'user' },
    })
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'normaluser', password: 'password123' },
    })
    const userCookie = extractCookie(loginRes.headers['set-cookie'])!

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: userCookie },
      payload: { kind: 'radarr', name: 'Radarr', baseUrl: 'http://localhost:7878', apiKey: 'key' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('normal user: test → 403', async () => {
    // Create integration as admin first
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: { kind: 'radarr', name: 'Radarr', baseUrl: 'http://localhost:7878', apiKey: 'key' },
    })
    const { id } = JSON.parse(createRes.body).data

    await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { Cookie: adminCookie },
      payload: { username: 'normaluser2', password: 'password123', role: 'user' },
    })
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'normaluser2', password: 'password123' },
    })
    const userCookie = extractCookie(loginRes.headers['set-cookie'])!

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/test`,
      headers: { Cookie: userCookie },
    })
    expect(res.statusCode).toBe(403)
  })

  it('normal user: sync → 403', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: { kind: 'radarr', name: 'Radarr', baseUrl: 'http://localhost:7878', apiKey: 'key' },
    })
    const { id } = JSON.parse(createRes.body).data

    await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { Cookie: adminCookie },
      payload: { username: 'normaluser3', password: 'password123', role: 'user' },
    })
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'normaluser3', password: 'password123' },
    })
    const userCookie = extractCookie(loginRes.headers['set-cookie'])!

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/sync`,
      headers: { Cookie: userCookie },
    })
    expect(res.statusCode).toBe(403)
  })

  it('unauthenticated: all integration routes → 401', async () => {
    const routes = [
      { method: 'GET', url: '/api/v1/integrations' },
      { method: 'POST', url: '/api/v1/integrations' },
      { method: 'GET', url: '/api/v1/integrations/nonexistent-id' },
      { method: 'PATCH', url: '/api/v1/integrations/nonexistent-id' },
      { method: 'DELETE', url: '/api/v1/integrations/nonexistent-id' },
      { method: 'POST', url: '/api/v1/integrations/nonexistent-id/test' },
      { method: 'POST', url: '/api/v1/integrations/nonexistent-id/sync' },
      { method: 'GET', url: '/api/v1/integrations/nonexistent-id/items' },
    ]

    for (const route of routes) {
      const res = await app.inject({ method: route.method as any, url: route.url })
      expect(res.statusCode, `Expected 401 for ${route.method} ${route.url}`).toBe(401)
    }
  })
})
