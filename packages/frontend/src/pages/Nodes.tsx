import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import {
  listNodes,
  createNode,
  deleteNode,
  testNode,
  syncNode,
  getFederationTokenStatus,
  generateFederationToken,
  revokeFederationToken,
} from '../api/nodes'
import type { NodeRecord } from '../api/nodes'

// ─── Status chip ──────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: NodeRecord['status'] }) {
  if (status === 'online') {
    return <span className="chip chip-accent">Online</span>
  }
  if (status === 'error') {
    return (
      <span
        className="chip"
        style={{
          background: 'oklch(0.70 0.13 25 / 0.10)',
          borderColor: 'oklch(0.70 0.13 25 / 0.35)',
          color: 'var(--bad)',
        }}
      >
        Error
      </span>
    )
  }
  if (status === 'offline') {
    return (
      <span
        className="chip"
        style={{
          background: 'oklch(0.70 0.13 25 / 0.10)',
          borderColor: 'oklch(0.70 0.13 25 / 0.35)',
          color: 'var(--bad)',
        }}
      >
        Offline
      </span>
    )
  }
  return <span className="chip chip-ghost">Unknown</span>
}

// ─── Timestamp ────────────────────────────────────────────────────────────────

function RelativeTime({ ts }: { ts: number | null }) {
  if (!ts) return <span style={{ color: 'var(--ink-4)' }}>Never</span>
  const d = new Date(ts)
  return (
    <span style={{ color: 'var(--ink-3)' }} title={d.toISOString()}>
      {d.toLocaleString()}
    </span>
  )
}

// ─── Add node form ────────────────────────────────────────────────────────────

interface AddNodeFormProps {
  onCreated: (node: NodeRecord) => void
  onCancel: () => void
}

function AddNodeForm({ onCreated, onCancel }: AddNodeFormProps) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !baseUrl.trim() || !apiToken.trim()) {
      setError('All fields are required.')
      return
    }
    setSaving(true)
    setError(null)
    const res = await createNode({
      name: name.trim(),
      base_url: baseUrl.trim(),
      api_token: apiToken.trim(),
    })
    setSaving(false)
    if (res.ok) {
      onCreated(res.data)
    } else {
      setError(res.error ?? 'Failed to add node.')
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="surface"
      style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}
    >
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--ink-1)' }}>
        Add Remote Node
      </h3>

      <div>
        <label className="field-label">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Remote Helix"
          className="input"
        />
      </div>

      <div>
        <label className="field-label">Base URL</label>
        <input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://remote.helix.local:3001"
          className="input"
        />
      </div>

      <div>
        <label className="field-label">Federation Token</label>
        <input
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder="Paste token from the remote node"
          className="input"
        />
      </div>

      {error && (
        <div style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? 'Adding…' : 'Add Node'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ─── This node section ────────────────────────────────────────────────────────

function ThisNodeSection() {
  const [hasToken, setHasToken] = useState(false)
  const [loading, setLoading] = useState(true)
  const [generatedToken, setGeneratedToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getFederationTokenStatus().then((res) => {
      if (res.ok) setHasToken(res.data.hasToken)
      setLoading(false)
    })
  }, [])

  async function handleGenerate() {
    setBusy(true)
    setError(null)
    const res = await generateFederationToken()
    setBusy(false)
    if (res.ok) {
      setHasToken(true)
      setGeneratedToken(res.data.token)
    } else {
      setError(res.error ?? 'Failed to generate token.')
    }
  }

  async function handleRevoke() {
    if (!confirm('Revoke the federation token? Remote nodes using it will lose access.')) return
    setBusy(true)
    setError(null)
    const res = await revokeFederationToken()
    setBusy(false)
    if (res.ok) {
      setHasToken(false)
      setGeneratedToken(null)
    } else {
      setError(res.error ?? 'Failed to revoke token.')
    }
  }

  return (
    <div className="surface" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 4px', color: 'var(--ink-1)' }}>
          This Node
        </h3>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
          Generate a federation token so other Helix instances can read this node's catalog.
        </p>
      </div>

      {loading ? (
        <span style={{ fontSize: 13, color: 'var(--ink-4)' }}>Loading…</span>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>
              Federation token:
            </span>
            {hasToken ? (
              <span className="chip chip-accent">Active</span>
            ) : (
              <span className="chip chip-ghost">Not set</span>
            )}
          </div>

          {generatedToken && (
            <div
              className="surface"
              style={{
                padding: '12px 14px',
                background: 'var(--bg-2)',
                borderRadius: 'var(--r-2)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--ink-3)', fontWeight: 500 }}>
                Copy this token now — it will not be shown again.
              </span>
              <code
                style={{
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--accent)',
                  wordBreak: 'break-all',
                  userSelect: 'all',
                }}
              >
                {generatedToken}
              </code>
            </div>
          )}

          {error && <div style={{ fontSize: 13, color: 'var(--bad)' }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleGenerate}
              disabled={busy}
            >
              {hasToken ? 'Regenerate Token' : 'Generate Token'}
            </button>
            {hasToken && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleRevoke}
                disabled={busy}
                style={{ color: 'var(--bad)' }}
              >
                Revoke
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Remote node row ──────────────────────────────────────────────────────────

interface NodeRowProps {
  node: NodeRecord
  onDeleted: (id: string) => void
  onUpdated: (node: NodeRecord) => void
}

function RemoteNodeRow({ node, onDeleted, onUpdated }: NodeRowProps) {
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<{ librariesSynced: number; itemsSynced: number } | null>(null)

  async function handleTest() {
    setTesting(true)
    setError(null)
    setSyncResult(null)
    const res = await testNode(node.id)
    setTesting(false)
    if (res.ok) {
      if (!res.data.online) {
        setError(res.data.error ?? 'Connection failed')
      }
      // Refresh node data by refetching list — caller handles via onUpdated
    } else {
      setError(res.error ?? 'Test failed')
    }
  }

  async function handleSync() {
    setSyncing(true)
    setError(null)
    setSyncResult(null)
    const res = await syncNode(node.id)
    setSyncing(false)
    if (res.ok) {
      setSyncResult({ librariesSynced: res.data.librariesSynced, itemsSynced: res.data.itemsSynced })
    } else {
      setError(res.error ?? 'Sync failed')
    }
  }

  async function handleDelete() {
    if (!confirm(`Remove node "${node.name}"? Imported catalog data will be deleted.`)) return
    const res = await deleteNode(node.id)
    if (res.ok) {
      onDeleted(node.id)
    }
  }

  // Suppress unused warning
  void onUpdated

  return (
    <div
      className="surface"
      style={{
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 500, fontSize: 14, color: 'var(--ink-1)' }}>
              {node.name}
            </span>
            <StatusChip status={node.status} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: 2 }}>
            {node.base_url ?? '—'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleTest}
            disabled={testing || syncing}
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleSync}
            disabled={testing || syncing}
          >
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleDelete}
            style={{ color: 'var(--bad)' }}
          >
            Remove
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 24, fontSize: 12, color: 'var(--ink-4)' }}>
        <span>Last seen: <RelativeTime ts={node.last_seen_at} /></span>
        <span>Last sync: <RelativeTime ts={node.last_sync_at} /></span>
      </div>

      {node.last_error && (
        <div style={{ fontSize: 12, color: 'var(--bad)' }}>{node.last_error}</div>
      )}
      {error && (
        <div style={{ fontSize: 12, color: 'var(--bad)' }}>{error}</div>
      )}
      {syncResult && (
        <div style={{ fontSize: 12, color: 'var(--accent)' }}>
          Synced {syncResult.librariesSynced} {syncResult.librariesSynced === 1 ? 'library' : 'libraries'},{' '}
          {syncResult.itemsSynced} {syncResult.itemsSynced === 1 ? 'item' : 'items'}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function Nodes() {
  const { user } = useAuth()
  const [nodes, setNodes] = useState<NodeRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadNodes()
  }, [])

  async function loadNodes() {
    setLoading(true)
    const res = await listNodes()
    setLoading(false)
    if (res.ok) {
      setNodes(res.data)
    } else {
      setError(res.error ?? 'Failed to load nodes.')
    }
  }

  function handleCreated(node: NodeRecord) {
    setNodes((prev) => [...prev, node])
    setShowAddForm(false)
  }

  function handleDeleted(id: string) {
    setNodes((prev) => prev.filter((n) => n.id !== id))
  }

  function handleUpdated(updated: NodeRecord) {
    setNodes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)))
  }

  if (user?.role !== 'admin') {
    return (
      <div style={{ padding: 32, color: 'var(--ink-3)', fontSize: 14 }}>
        Admin access required.
      </div>
    )
  }

  const remoteNodes = nodes.filter((n) => n.kind === 'remote')

  return (
    <div
      style={{
        padding: '24px 32px',
        maxWidth: 800,
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}
    >
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 4px', color: 'var(--ink-1)' }}>
          Nodes
        </h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
          Manage federation with remote Helix instances.
        </p>
      </div>

      <ThisNodeSection />

      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--ink-1)' }}>
            Remote Nodes
          </h2>
          {!showAddForm && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setShowAddForm(true)}
            >
              Add Node
            </button>
          )}
        </div>

        {showAddForm && (
          <div style={{ marginBottom: 16 }}>
            <AddNodeForm
              onCreated={handleCreated}
              onCancel={() => setShowAddForm(false)}
            />
          </div>
        )}

        {loading ? (
          <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>Loading…</div>
        ) : error ? (
          <div style={{ fontSize: 13, color: 'var(--bad)' }}>{error}</div>
        ) : remoteNodes.length === 0 ? (
          <div
            className="surface"
            style={{ padding: '20px', fontSize: 13, color: 'var(--ink-4)', textAlign: 'center' }}
          >
            No remote nodes registered yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {remoteNodes.map((node) => (
              <RemoteNodeRow
                key={node.id}
                node={node}
                onDeleted={handleDeleted}
                onUpdated={handleUpdated}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
