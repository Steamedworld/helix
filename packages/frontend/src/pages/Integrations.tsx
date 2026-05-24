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

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Integration['status'] }) {
  const styles: Record<Integration['status'], { bg: string; text: string; label: string }> = {
    online: { bg: 'rgba(76,175,125,0.12)', text: '#4caf7d', label: 'Online' },
    offline: { bg: 'rgba(255,95,95,0.12)', text: 'var(--danger)', label: 'Offline' },
    error: { bg: 'rgba(255,95,95,0.12)', text: 'var(--danger)', label: 'Error' },
    unknown: { bg: 'rgba(122,122,138,0.12)', text: 'var(--text-muted)', label: 'Unknown' },
  }
  const s = styles[status]
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 8px',
        background: s.bg,
        borderRadius: 4,
        color: s.text,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  )
}

// ─── Timestamp display ────────────────────────────────────────────────────────

function RelativeTime({ ts }: { ts: number | null }) {
  if (!ts) return <span style={{ color: 'var(--text-muted)' }}>Never</span>
  const d = new Date(ts)
  return (
    <span style={{ color: 'var(--text-muted)' }} title={d.toISOString()}>
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

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text)',
    fontSize: 13,
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: 'var(--text-muted)',
    marginBottom: 4,
    display: 'block',
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Add Integration</h3>

      <div>
        <label style={labelStyle}>Type</label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as IntegrationKind)}
          style={inputStyle}
        >
          <option value="radarr">Radarr (Movies)</option>
          <option value="sonarr">Sonarr (TV Shows)</option>
        </select>
      </div>

      <div>
        <label style={labelStyle}>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Radarr"
          style={inputStyle}
        />
      </div>

      <div>
        <label style={labelStyle}>Base URL</label>
        <input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:7878"
          style={inputStyle}
        />
      </div>

      <div>
        <label style={labelStyle}>API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="From Settings → General → Security"
          style={inputStyle}
          autoComplete="off"
        />
      </div>

      {error && (
        <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>{error}</p>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: '7px 16px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-muted)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          style={{
            padding: '7px 16px',
            background: 'var(--accent)',
            border: 'none',
            borderRadius: 'var(--radius)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.7 : 1,
          }}
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
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
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
            <span style={{ fontSize: 15, fontWeight: 600 }}>{integration.name}</span>
            <span
              style={{
                fontSize: 11,
                padding: '1px 6px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                color: 'var(--text-muted)',
              }}
            >
              {integration.kind}
            </span>
            <StatusBadge status={integration.status} />
            {!integration.enabled && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>disabled</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            {integration.baseUrl}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Key: <code style={{ fontFamily: 'monospace', letterSpacing: 1 }}>{integration.apiKeyMasked}</code>
          </div>
        </div>
      </div>

      {/* Timestamps */}
      <div style={{ display: 'flex', gap: 20, fontSize: 11, flexWrap: 'wrap' }}>
        <span>
          <span style={{ color: 'var(--text-muted)' }}>Last checked: </span>
          <RelativeTime ts={integration.lastCheckedAt} />
        </span>
        <span>
          <span style={{ color: 'var(--text-muted)' }}>Last synced: </span>
          <RelativeTime ts={integration.lastSyncedAt} />
        </span>
      </div>

      {integration.lastError && (
        <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>{integration.lastError}</p>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={handleTest}
          disabled={testing}
          style={{
            padding: '5px 12px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-muted)',
            fontSize: 12,
            cursor: testing ? 'default' : 'pointer',
            opacity: testing ? 0.6 : 1,
          }}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button
          onClick={handleSync}
          disabled={syncing || !integration.enabled}
          style={{
            padding: '5px 12px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-muted)',
            fontSize: 12,
            cursor: (syncing || !integration.enabled) ? 'default' : 'pointer',
            opacity: (syncing || !integration.enabled) ? 0.6 : 1,
          }}
        >
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        <button
          onClick={handleToggleEnabled}
          style={{
            padding: '5px 12px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-muted)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {integration.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          style={{
            padding: '5px 12px',
            background: 'rgba(255,95,95,0.08)',
            border: '1px solid rgba(255,95,95,0.3)',
            borderRadius: 'var(--radius)',
            color: 'var(--danger)',
            fontSize: 12,
            cursor: deleting ? 'default' : 'pointer',
            opacity: deleting ? 0.6 : 1,
            marginLeft: 'auto',
          }}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      {/* Feedback messages */}
      {testMessage && (
        <p style={{
          fontSize: 12,
          color: testMessage.startsWith('Connected') ? '#4caf7d' : 'var(--danger)',
          margin: 0,
          padding: '6px 10px',
          background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius)',
        }}>
          {testMessage}
        </p>
      )}

      {syncResult && (
        <div style={{
          fontSize: 12,
          padding: '8px 12px',
          background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius)',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Sync complete</div>
          <div style={{ color: 'var(--text-muted)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>Fetched: {syncResult.itemsFetched}</span>
            <span>Mapped: {syncResult.itemsMapped}</span>
            <span>Created: {syncResult.linksCreated}</span>
            <span>Updated: {syncResult.linksUpdated}</span>
          </div>
          {syncResult.errors.length > 0 && (
            <div style={{ color: 'var(--danger)', marginTop: 4 }}>
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
      <div style={{ color: 'var(--danger)', fontSize: 14 }}>
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
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 4 }}>Integrations</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6 }}>
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
            style={{
              padding: '8px 18px',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 'var(--radius)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            + Add Integration
          </button>
        </div>
      )}

      {/* Add form */}
      {showAddForm && (
        <AddIntegrationForm
          onCreated={handleCreated}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* List */}
      {loading && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading integrations…</p>
      )}

      {!loading && integrationList.length === 0 && !showAddForm && (
        <div
          style={{
            padding: '32px',
            textAlign: 'center',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            color: 'var(--text-muted)',
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
        style={{
          padding: '12px 16px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          fontSize: 12,
          color: 'var(--text-muted)',
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: 'var(--text)' }}>API key security:</strong> Keys are encrypted
        at rest with AES-256-GCM and never returned to the browser in plaintext. The key file
        is stored at <code style={{ fontFamily: 'monospace' }}>data/.helix_key</code> (not committed to git).
      </div>
    </div>
  )
}
