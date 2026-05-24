import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import {
  listIntegrations,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  testIntegration,
  syncIntegration,
} from '../api/integrations'
import type { Integration, IntegrationKind, SyncResult } from '../api/integrations'

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
      </div>

      {integration.lastError && (
        <p style={{ fontSize: 12, color: 'var(--bad)', margin: 0 }}>{integration.lastError}</p>
      )}

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

      {/* Info box */}
      <div
        className="surface"
        style={{
          padding: '12px 16px',
          background: 'var(--bg-3)',
          fontSize: 12,
          color: 'var(--ink-3)',
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: 'var(--ink-1)' }}>API key security:</strong> Keys are encrypted
        at rest with AES-256-GCM and never returned to the browser in plaintext. The key file
        is stored at{' '}
        <code className="mono" style={{ fontSize: 11 }}>data/.helix_key</code>{' '}
        (not committed to git).
      </div>
    </div>
  )
}
