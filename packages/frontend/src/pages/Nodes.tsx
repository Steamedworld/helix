import { useEffect, useState, useRef } from 'react'
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
  createInvite,
  listInvites,
  revokeInvite,
  acceptInvite,
  getNodeAccessSummary,
  updateNodeAccess,
} from '../api/nodes'
import { getServerConfig } from '../api/config'
import type { NodeRecord, NodeCapabilities, DirectPlaybackDiagnostic, InviteSummary, AcceptInviteResponse, AccessLibrarySummary, AccessUpdateGrant } from '../api/nodes'
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

// ─── Create Invite panel ──────────────────────────────────────────────────────

interface CreateInvitePanelProps {
  onDone: () => void
  serverConfig: ServerConfig | null
}

function CreateInvitePanel({ onDone, serverConfig }: CreateInvitePanelProps) {
  const [label, setLabel] = useState('')
  const [expiryDays, setExpiryDays] = useState<string>('30')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ compact: string; warning: string; baseUrlWarning?: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const baseUrlOk = serverConfig?.baseUrlConfigured && !serverConfig?.baseUrlIsLoopback

  async function handleGenerate() {
    setBusy(true)
    setError(null)
    const body: { label?: string; expires_in_days?: number } = {}
    if (label.trim()) body.label = label.trim()
    if (expiryDays && expiryDays !== 'none') body.expires_in_days = Number(expiryDays)

    const res = await createInvite(body)
    setBusy(false)
    if (res.ok) {
      setResult({
        compact: res.data.compact,
        warning: res.data.invite.warning,
        baseUrlWarning: res.data.base_url_warning,
      })
    } else {
      setError(res.error ?? 'Failed to create invite.')
    }
  }

  async function handleCopy() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.compact)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy to clipboard — select and copy manually.')
    }
  }

  if (result) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {result.baseUrlWarning && (
          <div
            style={{
              fontSize: 12,
              color: '#e6a817',
              background: 'oklch(0.78 0.14 65 / 0.07)',
              border: '1px solid oklch(0.78 0.14 65 / 0.25)',
              borderRadius: 'var(--r-1)',
              padding: '8px 12px',
              lineHeight: 1.5,
            }}
          >
            <strong>⚠ Server address not configured.</strong> {result.baseUrlWarning}
          </div>
        )}

        <div
          style={{
            background: 'var(--bg-2)',
            borderRadius: 'var(--r-1)',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--ink-3)', fontWeight: 500 }}>
            Invite string — copy this and send to the other home's admin
          </div>
          <code
            style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--accent)',
              wordBreak: 'break-all',
              userSelect: 'all',
              lineHeight: 1.5,
            }}
          >
            {result.compact}
          </code>
        </div>

        <div
          style={{
            fontSize: 12,
            color: 'var(--bad)',
            background: 'oklch(0.70 0.13 25 / 0.06)',
            border: '1px solid oklch(0.70 0.13 25 / 0.20)',
            borderRadius: 'var(--r-1)',
            padding: '8px 12px',
            lineHeight: 1.5,
          }}
        >
          <strong>Security:</strong> This invite can only be used once. Share it only with the admin of a trusted Helix home. Treat it like a password — revoke it immediately if exposed.
        </div>

        <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
          After the other admin connects using this invite, go to <strong>Library settings</strong> to choose
          which libraries users can access from that home.
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy invite string'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!baseUrlOk && serverConfig && (
        <div
          style={{
            fontSize: 12,
            color: '#e6a817',
            background: 'oklch(0.78 0.14 65 / 0.07)',
            border: '1px solid oklch(0.78 0.14 65 / 0.25)',
            borderRadius: 'var(--r-1)',
            padding: '8px 12px',
            lineHeight: 1.5,
          }}
        >
          <strong>⚠ Server address not configured.</strong> Set <code>BASE_URL</code> to a LAN, VPN, or HTTPS
          reverse-proxy URL so the other home can reach this server.{' '}
          <a href="/settings" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
            Settings → Server address
          </a>
        </div>
      )}

      <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
        This invite grants the other home's server server-to-server access to your configured libraries.
        Normal users do not get access automatically — you choose which libraries they can see in Library settings.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <label className="field-label">Label (optional)</label>
          <input
            type="text"
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. For living-room Helix"
          />
        </div>
        <div>
          <label className="field-label">Expiry</label>
          <select
            className="input"
            value={expiryDays}
            onChange={(e) => setExpiryDays(e.target.value)}
            style={{ width: 'auto' }}
          >
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="none">No expiry</option>
          </select>
          <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
            {expiryDays === 'none'
              ? 'This invite has no expiry — revoke it manually when no longer needed.'
              : `This invite expires in ${expiryDays} days.`}
          </div>
        </div>
      </div>

      <div
        style={{
          fontSize: 12,
          color: 'var(--bad)',
          background: 'oklch(0.70 0.13 25 / 0.06)',
          border: '1px solid oklch(0.70 0.13 25 / 0.20)',
          borderRadius: 'var(--r-1)',
          padding: '8px 12px',
          lineHeight: 1.5,
        }}
      >
        <strong>One-time use.</strong> This invite can only be used once. Share it only with the admin of a trusted Helix home.
      </div>

      {error && <div style={{ fontSize: 13, color: 'var(--bad)' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={handleGenerate} disabled={busy}>
          {busy ? 'Generating…' : 'Generate invite'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── Accept Invite panel ──────────────────────────────────────────────────────

interface AcceptInvitePanelProps {
  onConnected: () => void
  onCancel: () => void
  onSetupAccess?: (nodeId: string) => void
}

function AcceptInvitePanel({ onConnected, onCancel, onSetupAccess }: AcceptInvitePanelProps) {
  const [inviteText, setInviteText] = useState('')
  const [preview, setPreview] = useState<{
    home_name: string
    server_address: string
    expires_at: string | null
    label: string | null
  } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [syncNow, setSyncNow] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    name: string
    nodeId: string
    message: string
    alreadyConnected?: boolean
    syncResult?: AcceptInviteResponse['sync_result']
    syncWarning?: string
    consumeWarning?: string
  } | null>(null)

  function tryPreview(text: string) {
    const trimmed = text.trim()
    if (!trimmed) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    try {
      let parsed: Record<string, unknown>
      if (trimmed.startsWith('{')) {
        parsed = JSON.parse(trimmed)
      } else {
        const padded =
          trimmed.replace(/-/g, '+').replace(/_/g, '/') +
          '='.repeat((4 - (trimmed.length % 4)) % 4)
        parsed = JSON.parse(atob(padded))
      }
      if (!parsed.server_address || !parsed.token) {
        setPreview(null)
        setPreviewError('Invite is missing required fields.')
        return
      }
      setPreview({
        home_name: String(parsed.home_name ?? 'Unknown'),
        server_address: String(parsed.server_address ?? ''),
        expires_at: parsed.expires_at ? String(parsed.expires_at) : null,
        label: parsed.label ? String(parsed.label) : null,
      })
      setPreviewError(null)
    } catch {
      setPreview(null)
      setPreviewError('Could not parse invite — make sure you pasted the full string.')
    }
  }

  function handleChange(text: string) {
    setInviteText(text)
    setError(null)
    setResult(null)
    tryPreview(text)
  }

  async function handleConnect() {
    if (!inviteText.trim()) return
    setBusy(true)
    setError(null)
    const res = await acceptInvite(inviteText.trim(), syncNow)
    setBusy(false)
    if (res.ok) {
      setResult({
        name: res.data.node_name ?? 'Remote Home',
        nodeId: res.data.node_id,
        message: res.data.message ?? 'Connected.',
        alreadyConnected: res.data.already_connected,
        syncResult: res.data.sync_result,
        syncWarning: res.data.sync_warning,
        consumeWarning: res.data.consume_warning,
      })
      onConnected()
    } else {
      setError(res.error ?? 'Failed to connect.')
    }
  }

  if (result) {
    const hasSyncedItems = result.syncResult && result.syncResult.items_synced > 0
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            fontSize: 13,
            color: result.alreadyConnected ? '#e6a817' : 'var(--ok)',
            background: result.alreadyConnected
              ? 'oklch(0.78 0.14 65 / 0.07)'
              : 'oklch(0.78 0.10 152 / 0.07)',
            border: `1px solid ${result.alreadyConnected ? 'oklch(0.78 0.14 65 / 0.25)' : 'oklch(0.78 0.10 152 / 0.25)'}`,
            borderRadius: 'var(--r-1)',
            padding: '10px 12px',
            lineHeight: 1.5,
          }}
        >
          <strong>{result.alreadyConnected ? 'Already connected.' : `Connected to ${result.name}.`}</strong>
          {result.syncResult && !result.alreadyConnected && (
            <>
              <br />
              {hasSyncedItems
                ? `Synced ${result.syncResult.items_synced} ${result.syncResult.items_synced === 1 ? 'item' : 'items'} from remote catalog.`
                : 'No items synced from remote catalog.'}
            </>
          )}
        </div>

        {result.syncWarning && (
          <div style={{ fontSize: 12, color: '#e6a817' }}>
            Sync warning: {result.syncWarning}
          </div>
        )}

        {result.consumeWarning && (
          <div style={{ fontSize: 12, color: '#e6a817' }}>
            Note: {result.consumeWarning}
          </div>
        )}

        {!result.alreadyConnected && (
          <>
            {(!syncNow || !hasSyncedItems) && (
              <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
                Sync this home's catalog before assigning library access.
              </div>
            )}
            {onSetupAccess && (
              <button
                className="btn btn-primary btn-sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => onSetupAccess(result.nodeId)}
              >
                Set up access
              </button>
            )}
          </>
        )}

        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          Close
        </button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
        Paste the invite string you received from the other home's admin.
      </div>

      <textarea
        className="input"
        rows={4}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
        value={inviteText}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Paste invite string here…"
      />

      {previewError && (
        <div style={{ fontSize: 12, color: 'var(--bad)' }}>{previewError}</div>
      )}

      {preview && (
        <div
          style={{
            fontSize: 12,
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-1)',
            padding: '8px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--ink-1)' }}>Preview</div>
          <div><span style={{ color: 'var(--ink-4)' }}>Home name:</span> {preview.home_name}</div>
          <div><span style={{ color: 'var(--ink-4)' }}>Server address:</span> {preview.server_address}</div>
          {preview.label && <div><span style={{ color: 'var(--ink-4)' }}>Label:</span> {preview.label}</div>}
          {preview.expires_at && (
            <div>
              <span style={{ color: 'var(--ink-4)' }}>Expires:</span>{' '}
              {new Date(preview.expires_at).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* Sync on connect checkbox */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink-2)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={syncNow}
          onChange={(e) => setSyncNow(e.target.checked)}
        />
        Sync catalog after connecting
      </label>

      {error && <div style={{ fontSize: 13, color: 'var(--bad)' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleConnect}
          disabled={busy || !inviteText.trim() || !!previewError}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── Invite list ──────────────────────────────────────────────────────────────

interface InviteListProps {
  refreshKey: number
}

function InviteList({ refreshKey }: InviteListProps) {
  const [invites, setInvites] = useState<InviteSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [revoking, setRevoking] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    listInvites().then((res) => {
      if (res.ok) setInvites(res.data)
      setLoading(false)
    })
  }, [refreshKey])

  async function handleRevoke(id: string, label: string | null) {
    if (!confirm(`Revoke invite "${label ?? id}"? The invite string will stop working.`)) return
    setRevoking(id)
    const res = await revokeInvite(id)
    setRevoking(null)
    if (res.ok) {
      setInvites((prev) =>
        prev.map((inv) =>
          inv.id === id ? { ...inv, revoked_at: Date.now() } : inv
        )
      )
    }
  }

  if (loading) return <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>Loading…</div>
  if (invites.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--ink-4)', padding: '8px 0' }}>
        No invites created yet.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {invites.map((inv) => {
        const expired = inv.expires_at !== null && Date.now() > inv.expires_at
        const active = !inv.revoked_at && !expired && !inv.used_at
        return (
          <div
            key={inv.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 10px',
              background: 'var(--bg-2)',
              borderRadius: 'var(--r-1)',
              fontSize: 12,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, color: 'var(--ink-1)', marginBottom: 2 }}>
                {inv.label ?? <span style={{ color: 'var(--ink-4)' }}>(no label)</span>}
              </div>
              <div style={{ color: 'var(--ink-4)', display: 'flex', flexWrap: 'wrap', gap: '0 12px' }}>
                <span>Created: {new Date(inv.created_at).toLocaleDateString()}</span>
                {inv.expires_at && (
                  <span>Expires: {new Date(inv.expires_at).toLocaleDateString()}</span>
                )}
                {inv.used_at && (
                  <span style={{ color: 'var(--ok)' }}>Used: {new Date(inv.used_at).toLocaleDateString()}</span>
                )}
              </div>
            </div>
            <div style={{ flexShrink: 0 }}>
              {inv.revoked_at ? (
                <span className="chip" style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}>Revoked</span>
              ) : expired ? (
                <span className="chip chip-ghost">Expired</span>
              ) : inv.used_at ? (
                <span className="chip chip-accent">Used</span>
              ) : active ? (
                <span className="chip chip-accent">Active</span>
              ) : null}
            </div>
            {!inv.revoked_at && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ color: 'var(--bad)', flexShrink: 0 }}
                onClick={() => handleRevoke(inv.id, inv.label)}
                disabled={revoking === inv.id}
              >
                {revoking === inv.id ? '…' : 'Revoke'}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── This home section ────────────────────────────────────────────────────────

interface ThisHomeSectionProps {
  serverConfig: ServerConfig | null
  inviteRefreshKey: number
  onInviteCreated: () => void
}

function ThisHomeSection({ serverConfig, inviteRefreshKey, onInviteCreated }: ThisHomeSectionProps) {
  const [hasToken, setHasToken] = useState(false)
  const [loading, setLoading] = useState(true)
  const [generatedToken, setGeneratedToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreateInvite, setShowCreateInvite] = useState(false)
  const [showInviteList, setShowInviteList] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

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
    if (!confirm('Revoke the access token? Trusted homes using it will lose access.')) return
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

  function handleInviteDone() {
    setShowCreateInvite(false)
    onInviteCreated()
    setShowInviteList(true)
  }

  return (
    <div className="surface" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 4px', color: 'var(--ink-1)' }}>
          This Home
        </h3>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
          Create an invite so another Helix home's admin can connect to this home.
          The invite grants server-to-server access to your configured libraries.
        </p>
      </div>

      {loading ? (
        <span style={{ fontSize: 13, color: 'var(--ink-4)' }}>Loading…</span>
      ) : showCreateInvite ? (
        <CreateInvitePanel serverConfig={serverConfig} onDone={handleInviteDone} />
      ) : (
        <>
          {/* Primary invite action */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setShowCreateInvite(true)}
              disabled={busy}
            >
              Create invite
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowInviteList((v) => !v)}
            >
              {showInviteList ? 'Hide invite history' : 'Show invite history'}
            </button>
          </div>

          {/* Invite list */}
          {showInviteList && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 8 }}>
                Invite history
              </div>
              <InviteList refreshKey={inviteRefreshKey} />
            </div>
          )}

          {error && <div style={{ fontSize: 13, color: 'var(--bad)' }}>{error}</div>}

          {/* Advanced manual setup (collapsed) */}
          <div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowAdvanced((v) => !v)}
              style={{ fontSize: 12, color: 'var(--ink-4)' }}
            >
              {showAdvanced ? '▲ Hide advanced setup' : '▼ Advanced manual setup'}
            </button>

            {showAdvanced && (
              <div
                style={{
                  marginTop: 10,
                  padding: '14px',
                  background: 'var(--bg-2)',
                  borderRadius: 'var(--r-1)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
                  Generate a raw access token to manually configure a connection without using the invite flow.
                  The other admin must paste this token directly into their home's "Add Trusted Home" form.
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>Access token:</span>
                  {hasToken ? (
                    <span className="chip chip-accent">Active</span>
                  ) : (
                    <span className="chip chip-ghost">Not set</span>
                  )}
                </div>

                {generatedToken && (
                  <div
                    style={{
                      padding: '10px 12px',
                      background: 'var(--bg-3)',
                      borderRadius: 'var(--r-1)',
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

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={handleGenerate}
                    disabled={busy}
                  >
                    {hasToken ? 'Regenerate token' : 'Generate token'}
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
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Connect using invite section ─────────────────────────────────────────────

interface ConnectWithInviteSectionProps {
  onConnected: () => void
  onSetupAccess: (nodeId: string) => void
}

function ConnectWithInviteSection({ onConnected, onSetupAccess }: ConnectWithInviteSectionProps) {
  const [showPanel, setShowPanel] = useState(false)

  function handleConnected() {
    onConnected()
  }

  return (
    <div className="surface" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 4px', color: 'var(--ink-1)' }}>
          Connect using invite
        </h3>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
          Paste an invite string from another Helix home's admin to establish a connection.
        </p>
      </div>

      {showPanel ? (
        <AcceptInvitePanel
          onConnected={handleConnected}
          onCancel={() => setShowPanel(false)}
          onSetupAccess={onSetupAccess}
        />
      ) : (
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setShowPanel(true)}>
          Paste invite and connect
        </button>
      )}
    </div>
  )
}

// ─── Add trusted home form (manual, advanced) ─────────────────────────────────

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
        Add Trusted Home (manual)
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
        <label className="field-label">Access token</label>
        <input
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder="Paste access token from the trusted home"
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

// ─── Manage Access panel ─────────────────────────────────────────────────────

interface ManageAccessPanelProps {
  nodeId: string
}

function ManageAccessPanel({ nodeId }: ManageAccessPanelProps) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [libraries, setLibraries] = useState<AccessLibrarySummary[]>([])
  // Local grant state: Map<`${libraryId}:${userId}`, { canView, canPlay }>
  const [grantState, setGrantState] = useState<Map<string, { canView: boolean; canPlay: boolean }>>(new Map())

  useEffect(() => {
    setLoading(true)
    setError(null)
    getNodeAccessSummary(nodeId).then((res) => {
      setLoading(false)
      if (res.ok) {
        setLibraries(res.data.libraries)
        // Initialise local grant state from existing grants
        const map = new Map<string, { canView: boolean; canPlay: boolean }>()
        for (const lib of res.data.libraries) {
          for (const g of lib.grants) {
            map.set(`${lib.id}:${g.userId}`, { canView: g.canView, canPlay: g.canPlay })
          }
          for (const u of lib.ungrantedUsers) {
            map.set(`${lib.id}:${u.userId}`, { canView: false, canPlay: false })
          }
        }
        setGrantState(map)
      } else {
        setError(res.error ?? 'Failed to load access summary.')
      }
    })
  }, [nodeId])

  function handleToggle(libraryId: string, userId: string, field: 'canView' | 'canPlay') {
    setGrantState((prev) => {
      const key = `${libraryId}:${userId}`
      const cur = prev.get(key) ?? { canView: false, canPlay: false }
      const next = { ...cur }
      if (field === 'canView') {
        next.canView = !cur.canView
        // Revoking view also revokes play
        if (!next.canView) next.canPlay = false
      } else {
        next.canPlay = !cur.canPlay
        // Granting play requires view
        if (next.canPlay) next.canView = true
      }
      const updated = new Map(prev)
      updated.set(key, next)
      return updated
    })
    setSaveSuccess(false)
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(false)

    const grants: AccessUpdateGrant[] = []
    for (const [key, val] of grantState) {
      const [libraryId, userId] = key.split(':')
      grants.push({ libraryId, userId, canView: val.canView, canPlay: val.canPlay })
    }

    if (grants.length === 0) {
      setSaving(false)
      setSaveSuccess(true)
      return
    }

    const res = await updateNodeAccess(nodeId, grants)
    setSaving(false)
    if (res.ok) {
      // Update local library state with server response
      setLibraries(res.data.libraries)
      setSaveSuccess(true)
    } else {
      setSaveError(res.error ?? 'Failed to save access settings.')
    }
  }

  if (loading) {
    return <div style={{ fontSize: 12, color: 'var(--ink-4)', padding: '8px 0' }}>Loading access settings…</div>
  }
  if (error) {
    return <div style={{ fontSize: 12, color: 'var(--bad)' }}>{error}</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
        Admins always have access. Regular users only see libraries you grant.
        Grant access only for media and users you are authorized to manage.
      </div>

      {libraries.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: 'var(--ink-4)',
            background: 'var(--bg-2)',
            borderRadius: 'var(--r-1)',
            padding: '10px 12px',
          }}
        >
          No libraries found. Sync this home's catalog first.
        </div>
      ) : (
        libraries.map((lib) => {
          // Gather all users for this library (granted + ungranted)
          const grantedUsers = lib.grants.map((g) => ({ userId: g.userId, userName: g.userName }))
          const ungrantedUsers = lib.ungrantedUsers
          const allUsers = [...grantedUsers, ...ungrantedUsers]

          return (
            <div
              key={lib.id}
              style={{
                background: 'var(--bg-2)',
                borderRadius: 'var(--r-1)',
                padding: '10px 12px',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-1)', marginBottom: 8 }}>
                {lib.name} <span style={{ fontSize: 11, color: 'var(--ink-4)', fontWeight: 400 }}>({lib.kind})</span>
              </div>
              {allUsers.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>No users to manage.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--ink-4)', textAlign: 'left' }}>
                      <th style={{ paddingBottom: 4, fontWeight: 500 }}>User</th>
                      <th style={{ paddingBottom: 4, fontWeight: 500, textAlign: 'center', width: 80 }}>Can view</th>
                      <th style={{ paddingBottom: 4, fontWeight: 500, textAlign: 'center', width: 80 }}>Can play</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allUsers.map((u) => {
                      const key = `${lib.id}:${u.userId}`
                      const cur = grantState.get(key) ?? { canView: false, canPlay: false }
                      return (
                        <tr key={u.userId} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '5px 0', color: 'var(--ink-2)' }}>{u.userName}</td>
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={cur.canView}
                              onChange={() => handleToggle(lib.id, u.userId, 'canView')}
                            />
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={cur.canPlay}
                              onChange={() => handleToggle(lib.id, u.userId, 'canPlay')}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )
        })
      )}

      {saveError && <div style={{ fontSize: 12, color: 'var(--bad)' }}>{saveError}</div>}
      {saveSuccess && <div style={{ fontSize: 12, color: 'var(--ok)' }}>Access settings saved.</div>}

      {libraries.length > 0 && (
        <button
          className="btn btn-primary btn-sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save access settings'}
        </button>
      )}
    </div>
  )
}

// ─── Trusted home row ─────────────────────────────────────────────────────────

interface NodeRowProps {
  node: NodeRecord
  onDeleted: (id: string) => void
  onUpdated: (node: NodeRecord) => void
  defaultOpenAccess?: boolean
}

function TrustedHomeRow({ node, onDeleted, onUpdated, defaultOpenAccess = false }: NodeRowProps) {
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<{ librariesSynced: number; itemsSynced: number } | null>(null)
  const [diagnostic, setDiagnostic] = useState<DirectPlaybackDiagnostic | null>(null)
  const [showAccess, setShowAccess] = useState(defaultOpenAccess)
  const accessRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (defaultOpenAccess && accessRef.current) {
      accessRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [defaultOpenAccess])

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

      {/* Manage Access collapsible */}
      <div
        ref={accessRef}
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 10,
          marginTop: 2,
        }}
      >
        <button
          className="btn btn-ghost btn-sm"
          style={{ fontSize: 12, color: 'var(--ink-3)' }}
          onClick={() => setShowAccess((v) => !v)}
        >
          {showAccess ? '▲ Hide access settings' : '▼ Manage Access'}
        </button>

        {showAccess && (
          <div style={{ marginTop: 10 }}>
            <ManageAccessPanel nodeId={node.id} />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const BANNER_DISMISSED_KEY = 'helix.trustedHomesBannerDismissed'

export function Nodes() {
  const { user } = useAuth()
  const [nodes, setNodes] = useState<NodeRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showManualAddForm, setShowManualAddForm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null)
  const [inviteRefreshKey, setInviteRefreshKey] = useState(0)
  const [accessOpenNodeId, setAccessOpenNodeId] = useState<string | null>(null)
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
    setShowManualAddForm(false)
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
      // sessionStorage unavailable
    }
  }

  function handleConnected() {
    // Reload node list after invite-based connection
    loadNodes()
  }

  function handleSetupAccess(nodeId: string) {
    setAccessOpenNodeId(nodeId)
    // Scroll after a brief delay to allow re-render
    setTimeout(() => {
      const el = document.getElementById(`node-row-${nodeId}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
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
          Connect other Helix homes to access their private libraries alongside your own.
        </p>
      </div>

      {/* Admin banner: shown when remote nodes exist and local BASE_URL is unset/loopback */}
      <AdminBanner
        hasRemoteNodes={remoteNodes.length > 0}
        serverConfig={serverConfig}
        dismissed={bannerDismissed}
        onDismiss={handleDismissBanner}
      />

      {/* This Home: create invites and manage access token */}
      <ThisHomeSection
        serverConfig={serverConfig}
        inviteRefreshKey={inviteRefreshKey}
        onInviteCreated={() => setInviteRefreshKey((k) => k + 1)}
      />

      {/* Connect using invite from another home */}
      <ConnectWithInviteSection onConnected={handleConnected} onSetupAccess={handleSetupAccess} />

      {/* Connected trusted homes list */}
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
            Connected Trusted Homes
          </h2>
          {!showManualAddForm && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 12 }}
              onClick={() => setShowManualAddForm(true)}
            >
              + Manual setup
            </button>
          )}
        </div>

        {showManualAddForm && (
          <div style={{ marginBottom: 16 }}>
            <AddNodeForm
              onCreated={handleCreated}
              onCancel={() => setShowManualAddForm(false)}
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
            No trusted homes connected yet. Use "Connect using invite" above to add one.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {remoteNodes.map((node) => (
              <div key={node.id} id={`node-row-${node.id}`}>
                <TrustedHomeRow
                  node={node}
                  onDeleted={handleDeleted}
                  onUpdated={handleUpdated}
                  defaultOpenAccess={accessOpenNodeId === node.id}
                />
              </div>
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
