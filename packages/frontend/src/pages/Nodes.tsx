import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import {
  listNodes,
  createNode,
  deleteNode,
  testNode,
  syncNode,
  checkNodePlayback,
  getFederationTokenStatus,
  generateFederationToken,
  revokeFederationToken,
} from '../api/nodes'
import { getServerConfig } from '../api/config'
import type { NodeRecord, NodeCapabilities, DirectPlaybackDiagnostic } from '../api/nodes'
import type { ServerConfig } from '../api/config'

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

// ─── Direct playback status ───────────────────────────────────────────────────

function DirectPlaybackStatus({ capabilities }: { capabilities: NodeCapabilities | null }) {
  if (!capabilities) {
    return (
      <span className="chip chip-ghost" title="Run Check connection or Sync to fetch capabilities">
        Unknown
      </span>
    )
  }
  if (!capabilities.supportsRemotePlayback) {
    return (
      <span
        className="chip"
        style={{
          background: 'oklch(0.70 0.13 25 / 0.10)',
          borderColor: 'oklch(0.70 0.13 25 / 0.35)',
          color: 'var(--bad)',
        }}
      >
        Not supported
      </span>
    )
  }
  if (!capabilities.baseUrlConfigured) {
    return (
      <span
        className="chip"
        style={{
          background: 'oklch(0.78 0.14 65 / 0.12)',
          borderColor: 'oklch(0.78 0.14 65 / 0.35)',
          color: '#e6a817',
        }}
        title="Home server address is not set or is localhost — direct playback may fail for remote browsers"
      >
        ⚠ Needs address
      </span>
    )
  }
  return <span className="chip chip-accent">Ready</span>
}

// ─── Inline diagnostics panel ─────────────────────────────────────────────────

interface DiagnosticsPanelProps {
  diagnostic: DirectPlaybackDiagnostic
}

function DiagnosticsPanel({ diagnostic }: DiagnosticsPanelProps) {
  // Ready: playback available and server address configured + non-loopback
  if (diagnostic.directPlaybackAvailable && diagnostic.baseUrlConfigured) {
    return (
      <div
        style={{
          fontSize: 12,
          color: 'var(--ok)',
          background: 'oklch(0.78 0.10 152 / 0.07)',
          border: '1px solid oklch(0.78 0.10 152 / 0.25)',
          borderRadius: 'var(--r-1)',
          padding: '6px 10px',
          lineHeight: 1.5,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>✓</span>
        <span>
          <strong>Ready.</strong> Direct playback is available and the home server address is
          reachable.
        </span>
      </div>
    )
  }

  // Warning: playback available but server address is unset or loopback
  if (diagnostic.directPlaybackAvailable && !diagnostic.baseUrlConfigured) {
    return (
      <div
        style={{
          fontSize: 12,
          color: '#e6a817',
          background: 'oklch(0.78 0.14 65 / 0.07)',
          border: '1px solid oklch(0.78 0.14 65 / 0.25)',
          borderRadius: 'var(--r-1)',
          padding: '6px 10px',
          lineHeight: 1.5,
        }}
      >
        <strong>⚠ Warning.</strong>{' '}
        {diagnostic.warning ??
          'Browser reachability cannot be verified by the server. Make sure this home\'s server address is reachable from your browser.'}{' '}
        Set <code>BASE_URL</code> on this home to a LAN, VPN, or HTTPS reverse-proxy URL.
      </div>
    )
  }

  // Error / unsupported
  return (
    <div
      style={{
        fontSize: 12,
        color: 'var(--bad)',
        background: 'oklch(0.70 0.13 25 / 0.07)',
        border: '1px solid oklch(0.70 0.13 25 / 0.25)',
        borderRadius: 'var(--r-1)',
        padding: '6px 10px',
        lineHeight: 1.5,
      }}
    >
      <strong>Direct playback not available.</strong>{' '}
      {diagnostic.warning ?? 'This home does not support direct playback.'}
    </div>
  )
}

// ─── Admin banner ─────────────────────────────────────────────────────────────

interface AdminBannerProps {
  hasRemoteNodes: boolean
  serverConfig: ServerConfig | null
  dismissed: boolean
  onDismiss: () => void
}

function AdminBanner({ hasRemoteNodes, serverConfig, dismissed, onDismiss }: AdminBannerProps) {
  if (dismissed) return null
  if (!hasRemoteNodes) return null
  if (!serverConfig) return null
  // Only show when BASE_URL is unset or loopback
  if (serverConfig.baseUrlConfigured && !serverConfig.baseUrlIsLoopback) return null

  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '12px 16px',
        background: 'oklch(0.78 0.14 65 / 0.09)',
        border: '1px solid oklch(0.78 0.14 65 / 0.30)',
        borderRadius: 'var(--r-2)',
        fontSize: 13,
        color: '#e6a817',
        lineHeight: 1.55,
      }}
    >
      <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>⚠</span>
      <div style={{ flex: 1 }}>
        <strong style={{ color: '#f0b429' }}>
          Trusted-home playback may fail because this home's server address is not set to a
          browser-reachable URL.
        </strong>{' '}
        Set <code>BASE_URL</code> to a LAN, VPN, or HTTPS reverse-proxy URL.{' '}
        <a
          href="/settings"
          style={{ color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}
        >
          Go to Settings → Server address
        </a>
      </div>
      <button
        onClick={onDismiss}
        className="btn btn-icon btn-sm btn-ghost"
        title="Dismiss"
        style={{ color: '#e6a817', flexShrink: 0 }}
      >
        ×
      </button>
    </div>
  )
}

// ─── Add trusted home form ────────────────────────────────────────────────────

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
      setError(res.error ?? 'Failed to add trusted home.')
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="surface"
      style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}
    >
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--ink-1)' }}>
        Add Trusted Home
      </h3>

      <div>
        <label className="field-label">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Living Room Helix"
          className="input"
        />
      </div>

      <div>
        <label className="field-label">Home server address</label>
        <input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://media-box.local:3001"
          className="input"
        />
      </div>

      <div>
        <label className="field-label">Sharing token</label>
        <input
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder="Paste token from the trusted home"
          className="input"
        />
      </div>

      {error && (
        <div style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? 'Adding…' : 'Add Trusted Home'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ─── This home section ────────────────────────────────────────────────────────

function ThisHomeSection() {
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
    if (!confirm('Revoke the sharing token? Trusted homes using it will lose access.')) return
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
          This Home
        </h3>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
          Generate a sharing token so other Helix homes can read this home's catalog.
        </p>
      </div>

      {loading ? (
        <span style={{ fontSize: 13, color: 'var(--ink-4)' }}>Loading…</span>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>
              Sharing token:
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

// ─── Trusted home row ─────────────────────────────────────────────────────────

interface NodeRowProps {
  node: NodeRecord
  onDeleted: (id: string) => void
  onUpdated: (node: NodeRecord) => void
}

function TrustedHomeRow({ node, onDeleted, onUpdated }: NodeRowProps) {
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<{ librariesSynced: number; itemsSynced: number } | null>(null)
  const [diagnostic, setDiagnostic] = useState<DirectPlaybackDiagnostic | null>(null)

  async function handleTest() {
    setTesting(true)
    setError(null)
    setSyncResult(null)
    setDiagnostic(null)
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

  async function handleCheck() {
    setChecking(true)
    setError(null)
    setSyncResult(null)
    setDiagnostic(null)
    const res = await checkNodePlayback(node.id)
    setChecking(false)
    if (res.ok) {
      setDiagnostic(res.data)
    } else {
      setError(res.error ?? 'Check failed')
    }
  }

  async function handleSync() {
    setSyncing(true)
    setError(null)
    setSyncResult(null)
    setDiagnostic(null)
    const res = await syncNode(node.id)
    setSyncing(false)
    if (res.ok) {
      setSyncResult({ librariesSynced: res.data.librariesSynced, itemsSynced: res.data.itemsSynced })
    } else {
      setError(res.error ?? 'Sync failed')
    }
  }

  async function handleDelete() {
    if (!confirm(`Remove trusted home "${node.name}"? Imported catalog data will be deleted.`)) return
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
            disabled={testing || syncing || checking}
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleCheck}
            disabled={testing || syncing || checking}
            title="Check direct-playback readiness"
          >
            {checking ? 'Checking…' : 'Check connection'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleSync}
            disabled={testing || syncing || checking}
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
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Direct Play: <DirectPlaybackStatus capabilities={node.capabilities ?? null} />
        </span>
      </div>

      {/* Inline diagnostics result (shown after Check connection) */}
      {diagnostic && <DiagnosticsPanel diagnostic={diagnostic} />}

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

const BANNER_DISMISSED_KEY = 'helix.trustedHomesBannerDismissed'

export function Nodes() {
  const { user } = useAuth()
  const [nodes, setNodes] = useState<NodeRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null)
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(BANNER_DISMISSED_KEY) === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    loadNodes()
    getServerConfig().then((res) => {
      if (res.ok) setServerConfig(res.data)
    })
  }, [])

  async function loadNodes() {
    setLoading(true)
    const res = await listNodes()
    setLoading(false)
    if (res.ok) {
      setNodes(res.data)
    } else {
      setError(res.error ?? 'Failed to load trusted homes.')
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

  function handleDismissBanner() {
    setBannerDismissed(true)
    try {
      sessionStorage.setItem(BANNER_DISMISSED_KEY, 'true')
    } catch {
      // sessionStorage unavailable — dismissed only for this render
    }
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
          Trusted Homes
        </h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
          Register other Helix homes to browse their shared libraries alongside your own.
        </p>
      </div>

      {/* Admin banner: shown when remote nodes exist and local BASE_URL is unset/loopback */}
      <AdminBanner
        hasRemoteNodes={remoteNodes.length > 0}
        serverConfig={serverConfig}
        dismissed={bannerDismissed}
        onDismiss={handleDismissBanner}
      />

      <ThisHomeSection />

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
            Trusted Homes
          </h2>
          {!showAddForm && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setShowAddForm(true)}
            >
              Add Trusted Home
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
            No trusted homes registered yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {remoteNodes.map((node) => (
              <TrustedHomeRow
                key={node.id}
                node={node}
                onDeleted={handleDeleted}
                onUpdated={handleUpdated}
              />
            ))}
          </div>
        )}

        {/* Direct playback explainer */}
        <div
          className="surface"
          style={{
            marginTop: 12,
            padding: '12px 16px',
            background: 'var(--bg-3)',
            fontSize: 12,
            color: 'var(--ink-3)',
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: 'var(--ink-2)' }}>Direct playback</strong> streams media from the
          source home directly to your browser — Helix does not relay or transcode.{' '}
          Set <code>BASE_URL=http://&lt;host&gt;:&lt;port&gt;</code> on each home to a URL your
          browser can reach. For LAN use: <code>http://media-box.local:3001</code>. For remote
          access you need a reverse proxy or VPN — Helix does not provide relay or NAT traversal.
        </div>
      </div>
    </div>
  )
}
