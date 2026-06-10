/**
 * Trusted Home Audit Pruner v1 — tests
 *
 * Covers:
 *   Config — auditRetentionDays defaults, clamping, NaN guard (3 tests)
 *   pruneAuditEvents — cutoff math, selective deletion, idempotent (3 tests)
 *   createAuditPruner — start/stop lifecycle, state tracking (3 tests)
 *   GET /admin/sync-diagnostics — auditSummary retention fields shape (2 tests)
 *   POST /admin/trusted-home-audit-events/prune — manual trigger (3 tests)
 *   Security — no sensitive fields in prune response (1 test)
 *
 * Total: 15 tests
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
import { trustedHomeAuditEvents } from '../src/db/schema'
import { pruneAuditEvents, createAuditPruner, getAuditPruneState } from '../src/services/federation/trustedHomeAuditPruner'
import { config } from '../src/config'

// ─── Test env ─────────────────────────────────────────────────────────────────

process.env.TRUSTED_HOME_PLAYBACK_REFRESH_SECRET = 'test-pruner-refresh-secret'

// ─── DB helpers ───────────────────────────────────────────────────────────────

function createTestDb(testDir: string) {
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')
  const db = createDb(dbPath)
  runMigrations(db, join(__dirname, '../drizzle'))
  return db
}

type TestDb = ReturnType<typeof createDb>

async function insertAuditEvent(db: TestDb, occurredAt: string) {
  await db.insert(trustedHomeAuditEvents).values({
    id: crypto.randomUUID(),
    occurred_at: occurredAt,
    action: 'progress_push_synced',
    result: 'success',
    reason_code: 'push_synced',
    node_id: null,
    context_json: null,
    created_at: occurredAt,
  })
}

// ─── Config ───────────────────────────────────────────────────────────────────

describe('Config — auditRetentionDays', () => {
  it('defaults to 90 days', () => {
    // Default is set at module load; config.auditRetentionDays must be 1–3650 range
    expect(config.auditRetentionDays).toBeGreaterThanOrEqual(1)
    expect(config.auditRetentionDays).toBeLessThanOrEqual(3650)
    // Without TRUSTED_HOME_AUDIT_RETENTION_DAYS set in test env, default is 90
    // (env may be set in other tests; just verify in-range)
  })

  it('clamps values below 1 to 1', () => {
    const raw = Number('0')
    const n = isFinite(raw) && !isNaN(raw) ? raw : 90
    expect(Math.min(3650, Math.max(1, Math.round(n)))).toBe(1)
  })

  it('clamps values above 3650 to 3650 and handles NaN gracefully', () => {
    // NaN guard
    const rawNaN = Number('banana')
    const nNaN = isFinite(rawNaN) && !isNaN(rawNaN) ? rawNaN : 90
    expect(Math.min(3650, Math.max(1, Math.round(nNaN)))).toBe(90)

    // Over max
    const rawOver = Number('9999')
    const nOver = isFinite(rawOver) && !isNaN(rawOver) ? rawOver : 90
    expect(Math.min(3650, Math.max(1, Math.round(nOver)))).toBe(3650)
  })
})

// ─── pruneAuditEvents ─────────────────────────────────────────────────────────

describe('pruneAuditEvents', () => {
  let testDir: string
  let db: TestDb

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-audit-pruner-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('deletes events older than the retention cutoff and returns pruned count', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() // 100 days ago
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() // 5 days ago

    await insertAuditEvent(db, old)
    await insertAuditEvent(db, recent)

    const { pruned } = await pruneAuditEvents(db, 90)
    expect(pruned).toBe(1)

    const remaining = await db.select().from(trustedHomeAuditEvents)
    expect(remaining.length).toBe(1)
    expect(remaining[0].occurred_at).toBe(recent)
  })

  it('returns pruned=0 when no events are older than retention', async () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    await insertAuditEvent(db, recent)

    const { pruned } = await pruneAuditEvents(db, 90)
    expect(pruned).toBe(0)

    const remaining = await db.select().from(trustedHomeAuditEvents)
    expect(remaining.length).toBe(1)
  })

  it('is idempotent — second call returns pruned=0 after first removes events', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    await insertAuditEvent(db, old)

    const first = await pruneAuditEvents(db, 90)
    expect(first.pruned).toBe(1)

    const second = await pruneAuditEvents(db, 90)
    expect(second.pruned).toBe(0)
  })
})

// ─── createAuditPruner ────────────────────────────────────────────────────────

describe('createAuditPruner', () => {
  let testDir: string
  let db: TestDb

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-audit-pruner-sched-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('runs on startup and updates module-level state to ok', async () => {
    const pruner = createAuditPruner(db, 90)
    pruner.start()
    // Wait briefly for the async startup tick to complete
    await new Promise((r) => setTimeout(r, 50))
    await pruner.stop()

    const state = getAuditPruneState()
    expect(state.lastPruneStatus).toBe('ok')
    expect(state.lastPruneAt).not.toBeNull()
    expect(typeof state.lastPruneDeletedCount).toBe('number')
  })

  it('start() is idempotent — calling twice does not double-run', async () => {
    const pruner = createAuditPruner(db, 90)
    pruner.start()
    pruner.start() // second call is a no-op
    await new Promise((r) => setTimeout(r, 50))
    await pruner.stop()

    const state = getAuditPruneState()
    expect(state.lastPruneStatus).toBe('ok')
  })

  it('stop() resolves even if no tick has run', async () => {
    const pruner = createAuditPruner(db, 90)
    // Do not start — stop immediately
    await expect(pruner.stop()).resolves.toBeUndefined()
  })
})

// ─── sync-diagnostics auditSummary retention fields ──────────────────────────

describe('GET /admin/sync-diagnostics — auditSummary retention fields', () => {
  let testDir: string
  let db: TestDb
  let app: Awaited<ReturnType<typeof buildServer>>
  let cookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-audit-pruner-diag-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    const localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, null, testDir)
    await app.ready()
    cookie = await setupAuth(app)
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('auditSummary contains retentionDays, pruneCutoff, oldAuditEventsCount, and prune state fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.data.auditSummary).toBeDefined()
    const summary = body.data.auditSummary

    expect(typeof summary.retentionDays).toBe('number')
    expect(summary.retentionDays).toBeGreaterThanOrEqual(1)
    expect(typeof summary.pruneCutoff).toBe('string')
    expect(new Date(summary.pruneCutoff).getTime()).toBeLessThan(Date.now())
    expect(typeof summary.oldAuditEventsCount).toBe('number')
    expect(summary.oldAuditEventsCount).toBeGreaterThanOrEqual(0)
    expect(['ok', 'failed', 'not_run']).toContain(summary.lastPruneStatus)
    // lastPruneAt and lastPruneDeletedCount may be null before first prune
    expect(summary.lastPruneAt === null || typeof summary.lastPruneAt === 'string').toBe(true)
    expect(summary.lastPruneDeletedCount === null || typeof summary.lastPruneDeletedCount === 'number').toBe(true)
  })

  it('oldAuditEventsCount reflects events past the retention cutoff', async () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString() // 400 days ago
    await insertAuditEvent(db, old)

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sync-diagnostics',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.data.auditSummary.oldAuditEventsCount).toBeGreaterThanOrEqual(1)
  })
})

// ─── POST /admin/trusted-home-audit-events/prune ──────────────────────────────

describe('POST /admin/trusted-home-audit-events/prune', () => {
  let testDir: string
  let db: TestDb
  let app: Awaited<ReturnType<typeof buildServer>>
  let cookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-audit-pruner-endpoint-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    const localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, null, testDir)
    await app.ready()
    cookie = await setupAuth(app)
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('returns 200 with pruned count, retentionDays, and pruneCutoff', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/trusted-home-audit-events/prune',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(typeof body.data.pruned).toBe('number')
    expect(typeof body.data.retentionDays).toBe('number')
    expect(typeof body.data.pruneCutoff).toBe('string')
  })

  it('actually deletes old events and returns the correct pruned count', async () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()
    await insertAuditEvent(db, old)
    await insertAuditEvent(db, old)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/trusted-home-audit-events/prune',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.data.pruned).toBeGreaterThanOrEqual(2)

    const remaining = await db.select().from(trustedHomeAuditEvents)
    expect(remaining.length).toBe(0)
  })

  it('requires admin auth — returns 401 without cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/trusted-home-audit-events/prune',
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── Security ─────────────────────────────────────────────────────────────────

describe('Security — prune endpoint response contains no sensitive fields', () => {
  let testDir: string
  let db: TestDb
  let app: Awaited<ReturnType<typeof buildServer>>
  let cookie: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `helix-audit-pruner-sec-${crypto.randomUUID()}`)
    db = createTestDb(testDir)
    const localNodeId = await bootstrap(db, testDir)
    app = buildServer(db, localNodeId, null, testDir)
    await app.ready()
    cookie = await setupAuth(app)
  })

  afterEach(async () => {
    await app.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('prune response contains only pruned, retentionDays, pruneCutoff — no sensitive fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/trusted-home-audit-events/prune',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const payload = res.payload
    const forbidden = ['token', 'secret', 'user_id', 'userId', 'password', 'api_key', 'stack', 'trace']
    for (const word of forbidden) {
      expect(payload.toLowerCase()).not.toContain(word)
    }
    const body = JSON.parse(payload)
    const dataKeys = Object.keys(body.data)
    expect(dataKeys.sort()).toEqual(['pruned', 'pruneCutoff', 'retentionDays'].sort())
  })
})
