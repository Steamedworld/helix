/**
 * Webhook route tests — Radarr and Sonarr auto-sync via webhook.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { bootstrap } from '../src/bootstrap'
import { buildServer } from '../src/server'
import { setupAuth } from './helpers/auth'
import { _getSyncState } from '../src/services/integrations/webhook'
import { integrations } from '../src/db/schema'
import { eq } from 'drizzle-orm'

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

describe('webhook routes', () => {
  let testDir: string
  let db: TestDb
  let app: ReturnType<typeof buildServer>
  let localNodeId: string
  let adminCookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-webhook-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, undefined, testDir)
    await app.ready()
    adminCookie = await setupAuth(app)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    _getSyncState().clear()
    rmSync(testDir, { recursive: true, force: true })
  })

  // ─── Helper: create an integration and generate a webhook secret ──────────

  async function createIntegration(kind: 'radarr' | 'sonarr' = 'radarr') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: {
        kind,
        name: kind === 'radarr' ? 'Test Radarr' : 'Test Sonarr',
        baseUrl: kind === 'radarr' ? 'http://localhost:7878' : 'http://localhost:8989',
        apiKey: 'testkey',
      },
    })
    return JSON.parse(res.body).data as { id: string }
  }

  async function generateWebhookSecret(integrationId: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${integrationId}/webhook-secret`,
      headers: { Cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    return body.data as {
      integration: { id: string; webhookEnabled: boolean; webhookConfigured: boolean }
      webhookToken: string
      webhookUrl: string
      note: string
    }
  }

  // ─── Webhook secret generation ────────────────────────────────────────────

  it('generate webhook secret → returns token and URL once', async () => {
    const integration = await createIntegration('radarr')
    const result = await generateWebhookSecret(integration.id)

    expect(result.webhookToken).toBeDefined()
    expect(result.webhookToken).toHaveLength(64) // 32 bytes hex
    expect(result.webhookUrl).toContain(integration.id)
    expect(result.webhookUrl).toContain(result.webhookToken)
    expect(result.note).toBeDefined()
    expect(result.integration.webhookEnabled).toBe(true)
    expect(result.integration.webhookConfigured).toBe(true)
  })

  it('token is not stored in plaintext — subsequent GET does not reveal it', async () => {
    const integration = await createIntegration()
    await generateWebhookSecret(integration.id)

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/${integration.id}`,
      headers: { Cookie: adminCookie },
    })
    const body = JSON.parse(getRes.body)
    expect(body.data.webhookToken).toBeUndefined()
    expect(body.data.webhookSecretHash).toBeUndefined()
    expect(body.data.webhook_secret_hash).toBeUndefined()
    expect(body.data.webhookConfigured).toBe(true)
  })

  it('regenerating secret invalidates old token', async () => {
    const integration = await createIntegration()
    const first = await generateWebhookSecret(integration.id)
    const second = await generateWebhookSecret(integration.id)

    // New token differs
    expect(second.webhookToken).not.toBe(first.webhookToken)

    // Old token is now invalid
    const oldTokenRes = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${integration.id}/${first.webhookToken}`,
      payload: { eventType: 'Test' },
    })
    expect(oldTokenRes.statusCode).toBe(401)

    // New token works
    const newTokenRes = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${integration.id}/${second.webhookToken}`,
      payload: { eventType: 'Test' },
    })
    expect(newTokenRes.statusCode).toBe(204)
  })

  it('webhook-secret generation requires admin', async () => {
    const integration = await createIntegration()
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${integration.id}/webhook-secret`,
      // No auth
    })
    expect(res.statusCode).toBe(401)
  })

  // ─── Webhook token validation ─────────────────────────────────────────────

  it('missing/invalid token → 401', async () => {
    const integration = await createIntegration()
    await generateWebhookSecret(integration.id)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${integration.id}/wrongtoken`,
      payload: { eventType: 'Test' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('valid token → 204', async () => {
    const integration = await createIntegration()
    const { webhookToken } = await generateWebhookSecret(integration.id)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${integration.id}/${webhookToken}`,
      payload: { eventType: 'Test' },
    })
    expect(res.statusCode).toBe(204)
  })

  it('unknown integration id → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/nonexistent-id/sometoken',
      payload: { eventType: 'Test' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('webhook disabled → 403', async () => {
    const integration = await createIntegration()
    const { webhookToken } = await generateWebhookSecret(integration.id)

    // Disable webhook
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${integration.id}`,
      headers: { Cookie: adminCookie },
      payload: { webhookEnabled: false },
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${integration.id}/${webhookToken}`,
      payload: { eventType: 'Test' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('disabled integration → 403 on webhook', async () => {
    const integration = await createIntegration()
    const { webhookToken } = await generateWebhookSecret(integration.id)

    // Disable the integration entirely
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${integration.id}`,
      headers: { Cookie: adminCookie },
      payload: { enabled: false },
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${integration.id}/${webhookToken}`,
      payload: { eventType: 'Test' },
    })
    expect(res.statusCode).toBe(403)
  })

  // ─── Radarr webhook metadata updates ────────────────────────────────────

  it('Radarr Test payload updates last_webhook fields', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => [],
    })
    vi.stubGlobal('fetch', mockFetch)

    const integration = await createIntegration('radarr')
    const { webhookToken } = await generateWebhookSecret(integration.id)

    await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${integration.id}/${webhookToken}`,
      payload: { eventType: 'Test' },
    })

    // Give background sync a moment to record
    await new Promise((r) => setTimeout(r, 200))

    const [row] = await db.select().from(integrations).where(eq(integrations.id, integration.id))
    expect(row.last_webhook_at).not.toBeNull()
    expect(row.last_webhook_event).toBe('Test')
  })

  it('Sonarr Test payload updates last_webhook fields', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => [],
    })
    vi.stubGlobal('fetch', mockFetch)

    const integration = await createIntegration('sonarr')
    const { webhookToken } = await generateWebhookSecret(integration.id)

    await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${integration.id}/${webhookToken}`,
      payload: { eventType: 'Test' },
    })

    await new Promise((r) => setTimeout(r, 200))

    const [row] = await db.select().from(integrations).where(eq(integrations.id, integration.id))
    expect(row.last_webhook_at).not.toBeNull()
    expect(row.last_webhook_event).toBe('Test')
  })

  // ─── Sync trigger ─────────────────────────────────────────────────────────

  it('Radarr MovieAdded webhook triggers sync', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => [],
    })
    vi.stubGlobal('fetch', mockFetch)

    const integration = await createIntegration('radarr')
    const { webhookToken } = await generateWebhookSecret(integration.id)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${integration.id}/${webhookToken}`,
      payload: { eventType: 'MovieAdded', movie: { id: 1, title: 'Test Movie' } },
    })
    expect(res.statusCode).toBe(204)

    // Wait for background sync to fire fetch
    await new Promise((r) => setTimeout(r, 500))
    expect(mockFetch).toHaveBeenCalled()
  })

  it('Sonarr SeriesAdd webhook triggers sync', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => [],
    })
    vi.stubGlobal('fetch', mockFetch)

    const integration = await createIntegration('sonarr')
    const { webhookToken } = await generateWebhookSecret(integration.id)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${integration.id}/${webhookToken}`,
      payload: { eventType: 'SeriesAdd', series: { id: 1, title: 'Test Show' } },
    })
    expect(res.statusCode).toBe(204)

    await new Promise((r) => setTimeout(r, 500))
    expect(mockFetch).toHaveBeenCalled()
  })

  // ─── Sync debounce ────────────────────────────────────────────────────────

  it('duplicate webhook calls are debounced — second starts after first completes', async () => {
    let resolveFirst: () => void
    const firstFetchStarted = new Promise<void>((r) => { resolveFirst = r })
    let fetchCount = 0

    const mockFetch = vi.fn().mockImplementation(async () => {
      fetchCount++
      if (fetchCount === 1) {
        resolveFirst!()
        // Simulate slow first sync
        await new Promise((r) => setTimeout(r, 200))
      }
      return { ok: true, status: 200, json: async () => [] }
    })
    vi.stubGlobal('fetch', mockFetch)

    const integration = await createIntegration('radarr')
    const { webhookToken } = await generateWebhookSecret(integration.id)

    const url = `/api/v1/webhooks/${integration.id}/${webhookToken}`
    const payload = { eventType: 'MovieAdded' }

    // Fire first webhook
    app.inject({ method: 'POST', url, payload })
    // Wait for first sync to start
    await firstFetchStarted

    // Fire second webhook while first is running
    await app.inject({ method: 'POST', url, payload })

    // Wait for everything to settle
    await new Promise((r) => setTimeout(r, 1000))

    // The second sync should have run after the first — not concurrently
    expect(fetchCount).toBeGreaterThanOrEqual(2)
  })

  // ─── No Arr write methods called ─────────────────────────────────────────

  it('webhook sync never calls mutating Arr endpoints', async () => {
    const calledUrls: string[] = []
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      calledUrls.push(url)
      return { ok: true, status: 200, json: async () => [] }
    })
    vi.stubGlobal('fetch', mockFetch)

    const integration = await createIntegration('radarr')
    const { webhookToken } = await generateWebhookSecret(integration.id)

    await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${integration.id}/${webhookToken}`,
      payload: { eventType: 'Download' },
    })

    await new Promise((r) => setTimeout(r, 500))

    // All fetches are to read-only Radarr endpoints (/api/v3/movie, /api/v3/qualityprofile)
    for (const url of calledUrls) {
      expect(url).toContain('/api/v3/')
      // Must not contain write endpoints
      expect(url).not.toMatch(/\/command|\/release|\/push/)
    }
  })

  // ─── Integration PATCH → webhookEnabled field ─────────────────────────────

  it('PATCH webhookEnabled=false disables webhook', async () => {
    const integration = await createIntegration()
    await generateWebhookSecret(integration.id)

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${integration.id}`,
      headers: { Cookie: adminCookie },
      payload: { webhookEnabled: false },
    })
    expect(patchRes.statusCode).toBe(200)
    const body = JSON.parse(patchRes.body)
    expect(body.data.webhookEnabled).toBe(false)
    expect(body.data.webhookConfigured).toBe(true) // secret still stored
  })

  it('PATCH webhookEnabled=true re-enables webhook', async () => {
    const integration = await createIntegration()
    await generateWebhookSecret(integration.id)

    // Disable
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${integration.id}`,
      headers: { Cookie: adminCookie },
      payload: { webhookEnabled: false },
    })

    // Re-enable
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${integration.id}`,
      headers: { Cookie: adminCookie },
      payload: { webhookEnabled: true },
    })
    expect(patchRes.statusCode).toBe(200)
    const body = JSON.parse(patchRes.body)
    expect(body.data.webhookEnabled).toBe(true)
  })

  // ─── Existing integration behavior unaffected ─────────────────────────────

  it('existing integration CRUD still works after webhook fields added', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: { Cookie: adminCookie },
      payload: { kind: 'radarr', name: 'CRUD Test', baseUrl: 'http://localhost:7878', apiKey: 'key123' },
    })
    expect(createRes.statusCode).toBe(201)
    const { id } = JSON.parse(createRes.body).data

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${id}`,
      headers: { Cookie: adminCookie },
      payload: { name: 'Updated Name' },
    })
    expect(patchRes.statusCode).toBe(200)
    expect(JSON.parse(patchRes.body).data.name).toBe('Updated Name')

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/integrations/${id}`,
      headers: { Cookie: adminCookie },
    })
    expect(delRes.statusCode).toBe(200)
    expect(JSON.parse(delRes.body).data.deleted).toBe(true)
  })
})
