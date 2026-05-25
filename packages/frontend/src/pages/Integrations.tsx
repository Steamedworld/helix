import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import {
  listIntegrations,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  testIntegration,
  syncIntegration,
  generateWebhookSecret,
} from '../api/integrations'
import type { Integration, IntegrationKind, SyncResult } from '../api/integrations'
import { getQueueStats, clearQueue, enqueueAll, retryFailed } from '../api/enrichmentQueue'
import type { QueueStats } from '../api/enrichmentQueue'

// ─── Status chip ──────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: Integration['status'] }) {
  if (status === 'online') {
    return (
      <span className="chip chip-accent">Online</span>
    )
  }
  if (status === 'offline' || status === 'error') {
    return (
      <span className="chip" style={{ background: 'oklch(0.70 0.13 25 / 0.10)', borderColor: 'oklch(0.70 0.13 25 / 0.35)', color: 'var(--bad)' }}>
        {status === 'offline' ? 'Offline' : 'Error'}
      </span>
    )
  }
  return <span className="chip chip-ghost">Unknown</span>
}

// ─── Timestamp display ────────────────────────────────────────────────────────

function RelativeTime({ ts }: { ts: number | null }) {
  if (!ts) return <span style={{ color: 'var(--ink-4)' }}>Never</span>
  const d = new Date(ts)
  return (
    <span style={{ color: 'var(--ink-3)' }} title={d.toISOString()}>
      {d.toLocaleString()}
    </span>
  )
}

// ─── Add integration form ─────────────────────────────────────────────────────

interface AddFormProps {
  onCreated: (integration: Integration) => void
  onCancel: () => void
}

function AddIntegrationForm({ onCreated, onCancel }: AddFormProps) {
  const [kind, setKind] = useState<IntegrationKind>('radarr')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !baseUrl.trim() || !apiKey.trim()) {
      setError('All fields are required.')
      return
    }
    setSaving(true)
    setError(null)
    const res = await createIntegration({ kind, name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim() })
    setSaving(false)
    if (res.ok) {
      onCreated(res.data)
    } else {
      setError(res.error ?? 'Failed to create integration.')
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="surface"
      style={{
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--ink-1)' }}>Add Integration</h3>

      <div>
        <label className="field-label">Type</label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as IntegrationKind)}
          className="input"
          style={{ height: 38 }}
        >
          <option value="radarr">Radarr (Movies)</option>
          <option value="sonarr">Sonarr (TV Shows)</option>
        </select>
      </div>

      <div>
        <label className="field-label">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Radarr"
          className="input"
        />
      </div>

      <div>
        <label className="field-label">Base URL</label>
        <input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:7878"
          className="input"
        />
      </div>

      <div>
        <label className="field-label">API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="From Settings → General → Security"
          className="input"
          autoComplete="off"
        />
      </div>

      {error && (
        <p style={{ fontSize: 12, color: 'var(--bad)', margin: 0 }}>{error}</p>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="btn btn-primary btn-sm"
          style={{ opacity: saving ? 0.7 : 1 }}
        >
          {saving ? 'Adding…' : 'Add Integration'}
        </button>
      </div>
    </form>
  )
}

// ─── Integration card ──────────────────────────────────────────────────────────

interface IntegrationCardProps {
  integration: Integration
  onUpdated: (integration: Integration) => void
  onDeleted: (id: string) => void
}

function IntegrationCard({ integration, onUpdated, onDeleted }: IntegrationCardProps) {
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [testMessage, setTestMessage] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [generatingWebhook, setGeneratingWebhook] = useState(false)
  const [webhookToken, setWebhookToken] = useState<string | null>(null)
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null)
  const [webhookCopied, setWebhookCopied] = useState(false)

  async function handleTest() {
    setTesting(true)
    setTestMessage(null)
    setSyncResult(null)
    const res = await testIntegration(integration.id)
    setTesting(false)
    if (res.ok) {
      onUpdated(res.data.integration)
      const tr = res.data.testResult
      setTestMessage(tr.ok
        ? `Connected — version ${tr.version ?? '?'}`
        : `Failed: ${tr.error ?? 'Unknown error'}`)
    } else {
      setTestMessage(`Error: ${res.error}`)
    }
  }

  async function handleSync() {
    setSyncing(true)
    setTestMessage(null)
    setSyncResult(null)
    const res = await syncIntegration(integration.id)
    setSyncing(false)
    if (res.ok) {
      setSyncResult(res.data)
    } else {
      setTestMessage(`Sync error: ${res.error}`)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete "${integration.name}"? This will also remove all linked items.`)) return
    setDeleting(true)
    const res = await deleteIntegration(integration.id)
    setDeleting(false)
    if (res.ok) {
      onDeleted(integration.id)
    }
  }

  async function handleToggleEnabled() {
    const res = await updateIntegration(integration.id, { enabled: !integration.enabled })
    if (res.ok) onUpdated(res.data)
  }

  async function handleToggleWebhook() {
    const res = await updateIntegration(integration.id, { webhookEnabled: !integration.webhookEnabled })
    if (res.ok) onUpdated(res.data)
  }

  async function handleGenerateWebhookSecret() {
    setGeneratingWebhook(true)
    setWebhookToken(null)
    setWebhookUrl(null)
    setWebhookCopied(false)
    const res = await generateWebhookSecret(integration.id)
    setGeneratingWebhook(false)
    if (res.ok) {
      onUpdated(res.data.integration)
      setWebhookToken(res.data.webhookToken)
      setWebhookUrl(res.data.webhookUrl)
    }
  }

  async function handleCopyWebhookUrl() {
    if (!webhookUrl) return
    const fullUrl = `${window.location.origin}${webhookUrl}`
    await navigator.clipboard.writeText(fullUrl)
    setWebhookCopied(true)
    setTimeout(() => setWebhookCopied(false), 2000)
  }

  return (
    <div
      className="surface"
      style={{
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        opacity: integration.enabled ? 1 : 0.7,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-1)' }}>{integration.name}</span>
            <span className="chip chip-mono">{integration.kind}</span>
            <StatusChip status={integration.status} />
            {!integration.enabled && (
              <span className="chip chip-ghost">disabled</span>
            )}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
            {integration.baseUrl}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>
            Key: {integration.apiKeyMasked}
          </div>
        </div>
      </div>

      {/* Timestamps */}
      <div style={{ display: 'flex', gap: 20, fontSize: 11, flexWrap: 'wrap', color: 'var(--ink-4)' }}>
        <span>
          Last checked: <RelativeTime ts={integration.lastCheckedAt} />
        </span>
        <span>
          Last synced: <RelativeTime ts={integration.lastSyncedAt} />
        </span>
        {integration.lastWebhookAt && (
          <span>
            Last webhook: <RelativeTime ts={integration.lastWebhookAt} />
            {integration.lastWebhookEvent && (
              <span className="mono" style={{ fontSize: 10, marginLeft: 4 }}>
                ({integration.lastWebhookEvent})
              </span>
            )}
          </span>
        )}
      </div>

      {integration.lastError && (
        <p style={{ fontSize: 12, color: 'var(--bad)', margin: 0 }}>{integration.lastError}</p>
      )}

      {integration.lastWebhookError && (
        <p style={{ fontSize: 12, color: 'var(--bad)', margin: 0 }}>
          Webhook error: {integration.lastWebhookError}
        </p>
      )}

      {/* Webhook section */}
      <div
        style={{
          padding: '10px 12px',
          background: 'var(--bg-3)',
          borderRadius: 'var(--r-2)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' }}>Webhook auto-sync</span>
          {integration.webhookEnabled
            ? <span className="chip chip-accent" style={{ fontSize: 10 }}>Enabled</span>
            : <span className="chip chip-ghost" style={{ fontSize: 10 }}>Disabled</span>
          }
          {integration.webhookConfigured && !integration.webhookEnabled && (
            <span className="chip chip-ghost" style={{ fontSize: 10 }}>Secret configured</span>
          )}
        </div>

        {!integration.webhookConfigured && (
          <p style={{ fontSize: 11, color: 'var(--ink-4)', margin: 0 }}>
            Generate a webhook secret to enable push-based sync from {integration.kind === 'radarr' ? 'Radarr' : 'Sonarr'}.
            Helix remains read-only — no write commands are sent.
          </p>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            onClick={handleGenerateWebhookSecret}
            disabled={generatingWebhook}
            className="btn btn-sm btn-ghost"
            style={{ fontSize: 11, opacity: generatingWebhook ? 0.6 : 1 }}
          >
            {generatingWebhook
              ? 'Generating…'
              : integration.webhookConfigured
                ? 'Regenerate secret'
                : 'Generate secret'
            }
          </button>
          {integration.webhookConfigured && (
            <button
              onClick={handleToggleWebhook}
              className="btn btn-sm btn-ghost"
              style={{ fontSize: 11 }}
            >
              {integration.webhookEnabled ? 'Disable webhook' : 'Enable webhook'}
            </button>
          )}
        </div>

        {/* One-time token display */}
        {webhookToken && webhookUrl && (
          <div
            style={{
              padding: '10px 12px',
              background: 'oklch(0.55 0.14 145 / 0.08)',
              border: '1px solid oklch(0.55 0.14 145 / 0.25)',
              borderRadius: 'var(--r-2)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <p style={{ fontSize: 11, color: 'var(--ok)', margin: 0, fontWeight: 600 }}>
              Secret generated — copy this URL now. It will not be shown again.
            </p>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <code
                className="mono"
                style={{
                  fontSize: 10,
                  color: 'var(--ink-2)',
                  background: 'var(--bg-2)',
                  padding: '4px 8px',
                  borderRadius: 'var(--r-1)',
                  flex: 1,
                  overflowX: 'auto',
                  whiteSpace: 'nowrap',
                }}
              >
                {window.location.origin}{webhookUrl}
              </code>
              <button
                onClick={handleCopyWebhookUrl}
                className="btn btn-sm btn-ghost"
                style={{ fontSize: 11, flexShrink: 0 }}
              >
                {webhookCopied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p style={{ fontSize: 10, color: 'var(--ink-4)', margin: 0 }}>
              Paste this URL into {integration.kind === 'radarr' ? 'Radarr' : 'Sonarr'} → Settings → Connect → Webhook.
              Use method POST. No additional headers required.
            </p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={handleTest}
          disabled={testing}
          className="btn btn-sm"
          style={{ opacity: testing ? 0.6 : 1 }}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button
          onClick={handleSync}
          disabled={syncing || !integration.enabled}
          className="btn btn-sm"
          style={{ opacity: (syncing || !integration.enabled) ? 0.6 : 1 }}
        >
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        <button onClick={handleToggleEnabled} className="btn btn-sm btn-ghost">
          {integration.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="btn btn-sm"
          style={{
            marginLeft: 'auto',
            opacity: deleting ? 0.6 : 1,
            background: 'oklch(0.70 0.13 25 / 0.08)',
            borderColor: 'oklch(0.70 0.13 25 / 0.30)',
            color: 'var(--bad)',
          }}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      {/* Feedback messages */}
      {testMessage && (
        <p
          style={{
            fontSize: 12,
            color: testMessage.startsWith('Connected') ? 'var(--ok)' : 'var(--bad)',
            margin: 0,
            padding: '6px 10px',
            background: 'var(--bg-3)',
            borderRadius: 'var(--r-2)',
          }}
        >
          {testMessage}
        </p>
      )}

      {syncResult && (
        <div
          style={{
            fontSize: 12,
            padding: '8px 12px',
            background: 'var(--bg-3)',
            borderRadius: 'var(--r-2)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--ink-1)' }}>Sync complete</div>
          <div style={{ color: 'var(--ink-3)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>Fetched: {syncResult.itemsFetched}</span>
            <span>Mapped: {syncResult.itemsMapped}</span>
            <span>Created: {syncResult.linksCreated}</span>
            <span>Updated: {syncResult.linksUpdated}</span>
          </div>
          {syncResult.errors.length > 0 && (
            <div style={{ color: 'var(--bad)', marginTop: 4 }}>
              {syncResult.errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Enrichment queue widget ───────────────────────────────────────────────────

function EnrichmentQueueWidget() {
  const [stats, setStats] = useState<QueueStats | null>(null)
  const [clearing, setClearing] = useState(false)
  const [enqueueing, setEnqueueing] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function refresh() {
    const res = await getQueueStats()
    if (res.ok) setStats(res.data)
  }

  useEffect(() => {
    refresh()
  }, [])

  // Auto-poll while jobs are active
  useEffect(() => {
    if (pollRef.current) clearTimeout(pollRef.current)
    if (stats && (stats.pending > 0 || stats.running > 0)) {
      pollRef.current = setTimeout(() => refresh(), 3000)
    }
    return () => { if (pollRef.current) clearTimeout(pollRef.current) }
  }, [stats])

  async function handleClear() {
    setClearing(true)
    setMessage(null)
    const res = await clearQueue()
    setClearing(false)
    if (res.ok) {
      setMessage(`Removed ${res.data.removed} completed job${res.data.removed === 1 ? '' : 's'}.`)
      refresh()
    }
  }

  async function handleEnqueueAll() {
    setEnqueueing(true)
    setMessage(null)
    const res = await enqueueAll()
    setEnqueueing(false)
    if (res.ok) {
      setMessage(res.data.enqueued > 0
        ? `Enqueued ${res.data.enqueued} item${res.data.enqueued === 1 ? '' : 's'} for enrichment.`
        : 'No unenriched items found.')
      refresh()
    }
  }

  async function handleRetryFailed() {
    setRetrying(true)
    setMessage(null)
    const res = await retryFailed()
    setRetrying(false)
    if (res.ok) {
      setMessage(res.data.retried > 0
        ? `Reset ${res.data.retried} failed job${res.data.retried === 1 ? '' : 's'} for retry.`
        : 'No failed jobs to retry.')
      refresh()
    }
  }

  const isActive = stats !== null && (stats.pending > 0 || stats.running > 0)

  return (
    <div className="surface" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-1)' }}>Background Enrichment</span>
        {isActive && (
          <span className="chip chip-accent" style={{ fontSize: 10 }}>Active</span>
        )}
      </div>

      {stats === null ? (
        <p style={{ fontSize: 12, color: 'var(--ink-4)', margin: 0 }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--ink-3)', flexWrap: 'wrap' }}>
            <span>Pending: <strong style={{ color: stats.pending > 0 ? 'var(--ink-1)' : 'var(--ink-4)' }}>{stats.pending}</strong></span>
            <span>Running: <strong style={{ color: stats.running > 0 ? 'var(--ok)' : 'var(--ink-4)' }}>{stats.running}</strong></span>
            <span>Done: <strong style={{ color: 'var(--ink-4)' }}>{stats.done}</strong></span>
            <span>Failed: <strong style={{ color: stats.failed > 0 ? 'var(--bad)' : 'var(--ink-4)' }}>{stats.failed}</strong></span>
          </div>

          {stats.recentFailed.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--ink-3)', fontWeight: 600 }}>Recent failures</span>
              {stats.recentFailed.map((f) => (
                <div
                  key={f.id}
                  className="mono"
                  style={{ fontSize: 10, color: 'var(--bad)', padding: '4px 8px', background: 'var(--bg-3)', borderRadius: 'var(--r-1)' }}
                >
                  {f.lastError ?? 'Unknown error'}
                </div>
              ))}
            </div>
          )}

          {stats.recoveredOnStartup > 0 && (
            <p style={{ fontSize: 11, color: 'var(--ok)', margin: 0 }}>
              {stats.recoveredOnStartup} stale job{stats.recoveredOnStartup === 1 ? '' : 's'} recovered from last server shutdown and re-queued.
            </p>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              onClick={handleEnqueueAll}
              disabled={enqueueing}
              className="btn btn-sm btn-ghost"
              style={{ fontSize: 11, opacity: enqueueing ? 0.6 : 1 }}
            >
              {enqueueing ? 'Enqueueing…' : 'Enqueue all unenriched'}
            </button>
            {stats.failed > 0 && (
              <button
                onClick={handleRetryFailed}
                disabled={retrying}
                className="btn btn-sm btn-ghost"
                style={{ fontSize: 11, opacity: retrying ? 0.6 : 1 }}
              >
                {retrying ? 'Retrying…' : `Retry failed (${stats.failed})`}
              </button>
            )}
            <button
              onClick={handleClear}
              disabled={clearing || (stats.done === 0 && stats.failed === 0)}
              className="btn btn-sm btn-ghost"
              style={{ fontSize: 11, opacity: clearing ? 0.6 : 1 }}
            >
              {clearing ? 'Clearing…' : 'Clear completed'}
            </button>
            <button
              onClick={refresh}
              className="btn btn-sm btn-ghost"
              style={{ fontSize: 11 }}
            >
              Refresh
            </button>
          </div>

          {message && (
            <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: 0 }}>{message}</p>
          )}

          <p style={{ fontSize: 11, color: 'var(--ink-4)', margin: 0, lineHeight: 1.5 }}>
            Items are queued automatically after library scans and Arr syncs.
            Failed jobs can be retried; stale running jobs are recovered automatically on restart.
            Requires TMDB credentials — configure in{' '}
            <a href="/settings" style={{ color: 'var(--accent)' }}>Settings</a>.
          </p>
        </>
      )}
    </div>
  )
}

// ─── Integrations page ─────────────────────────────────────────────────────────

export function Integrations() {
  const { user } = useAuth()
  const [integrationList, setIntegrationList] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)

  // Non-admin: should not be accessible
  if (user?.role !== 'admin') {
    return (
      <div style={{ color: 'var(--bad)', fontSize: 14 }}>
        Access denied. Admin privileges required to manage integrations.
      </div>
    )
  }

  useEffect(() => {
    listIntegrations().then((res) => {
      if (res.ok) setIntegrationList(res.data)
      setLoading(false)
    })
  }, [])

  function handleCreated(integration: Integration) {
    setIntegrationList((prev) => [integration, ...prev])
    setShowAddForm(false)
  }

  function handleUpdated(integration: Integration) {
    setIntegrationList((prev) => prev.map((i) => (i.id === integration.id ? integration : i)))
  }

  function handleDeleted(id: string) {
    setIntegrationList((prev) => prev.filter((i) => i.id !== id))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 720 }}>
      {/* Header */}
      <div>
        <p className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.14em', marginBottom: 6 }}>
          ADMIN
        </p>
        <h1 className="display" style={{ fontSize: 48, lineHeight: 1, letterSpacing: '-0.02em' }}>
          Integrations
        </h1>
        <p style={{ color: 'var(--ink-3)', fontSize: 14, lineHeight: 1.6, marginTop: 8 }}>
          Connect Radarr and Sonarr to see download management status alongside your media.
          Helix is read-only — it displays monitoring status and quality profiles but never
          modifies your Arr configuration.
        </p>
      </div>

      {/* Add button */}
      {!showAddForm && (
        <div>
          <button
            onClick={() => setShowAddForm(true)}
            className="btn btn-primary"
          >
            + Add Integration
          </button>
        </div>
      )}

      {showAddForm && (
        <AddIntegrationForm
          onCreated={handleCreated}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {loading && (
        <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>Loading integrations…</p>
      )}

      {!loading && integrationList.length === 0 && !showAddForm && (
        <div
          className="surface"
          style={{
            padding: '32px',
            textAlign: 'center',
            color: 'var(--ink-3)',
            fontSize: 14,
          }}
        >
          No integrations configured. Add Radarr or Sonarr to get started.
        </div>
      )}

      {integrationList.map((integration) => (
        <IntegrationCard
          key={integration.id}
          integration={integration}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
        />
      ))}

      {/* Enrichment queue status */}
      <EnrichmentQueueWidget />

      {/* Info box */}
      <div
        className="surface"
        style={{
          padding: '12px 16px',
          background: 'var(--bg-3)',
          fontSize: 12,
          color: 'var(--ink-3)',
          lineHeight: 1.6,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div>
          <strong style={{ color: 'var(--ink-1)' }}>API key security:</strong> Keys are encrypted
          at rest with AES-256-GCM and never returned to the browser in plaintext. The key file
          is stored at{' '}
          <code className="mono" style={{ fontSize: 11 }}>data/.helix_key</code>{' '}
          (not committed to git).
        </div>
        <div>
          <strong style={{ color: 'var(--ink-1)' }}>Webhook security:</strong> Webhook tokens are
          SHA-256 hashed before storage and never retrievable after creation. Helix is strictly
          read-only — webhooks trigger catalog sync but never send write commands to Radarr or Sonarr.
        </div>
      </div>
    </div>
  )
}
