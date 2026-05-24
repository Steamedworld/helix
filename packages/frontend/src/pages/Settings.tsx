import { useEffect, useState } from 'react'
import { listProviders } from '../api/metadata'
import type { ProviderInfo } from '../api/metadata'

export function Settings() {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listProviders().then((res) => {
      if (res.ok) setProviders(res.data.providers)
      setLoading(false)
    })
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32, maxWidth: 680 }}>
      {/* Page header */}
      <div>
        <p className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.14em', marginBottom: 6 }}>
          SETTINGS
        </p>
        <h1 className="display" style={{ fontSize: 48, lineHeight: 1, letterSpacing: '-0.02em' }}>
          Configuration
        </h1>
        <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>
          Helix configuration and provider status.
        </p>
      </div>

      {/* Metadata providers */}
      <section>
        <h2 className="display" style={{ fontSize: 28, lineHeight: 1.1, marginBottom: 4 }}>
          Metadata Providers
        </h2>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 16, lineHeight: 1.6 }}>
          Providers enrich your media catalog with titles, overviews, artwork, and ratings.
          Configure credentials via environment variables on the backend.
        </p>

        {loading && (
          <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>Loading providers…</p>
        )}

        {!loading && providers !== null && providers.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>No providers registered.</p>
        )}

        {!loading && providers && providers.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {providers.map((p) => (
              <div
                key={p.id}
                className="surface"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 16px',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-1)' }}>{p.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
                    Supports: {p.supportedKinds.join(', ')}
                  </div>
                </div>
                <StatusBadge status={p.status} />
              </div>
            ))}
          </div>
        )}

        {/* Setup instructions */}
        <div
          className="surface"
          style={{
            marginTop: 16,
            padding: '12px 16px',
            background: 'var(--bg-3)',
            fontSize: 12,
            color: 'var(--ink-3)',
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: 'var(--ink-1)' }}>TMDB setup:</strong> Get a free API key at{' '}
          <a
            href="https://www.themoviedb.org/settings/api"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)' }}
          >
            themoviedb.org/settings/api
          </a>
          , then set{' '}
          <code
            className="mono"
            style={{
              background: 'var(--bg-0)',
              padding: '1px 5px',
              borderRadius: 3,
              fontSize: 11,
            }}
          >
            TMDB_READ_ACCESS_TOKEN
          </code>{' '}
          in your backend environment.
        </div>
      </section>
    </div>
  )
}

function StatusBadge({ status }: { status: ProviderInfo['status'] }) {
  const configs: Record<ProviderInfo['status'], { chipClass: string; label: string }> = {
    configured: { chipClass: 'chip', label: 'Configured' },
    unconfigured: { chipClass: 'chip chip-ghost', label: 'Not configured' },
    error: { chipClass: 'chip', label: 'Error' },
  }
  const c = configs[status]

  if (status === 'configured') {
    return (
      <span className="chip" style={{ background: 'oklch(0.78 0.10 152 / 0.12)', borderColor: 'oklch(0.78 0.10 152 / 0.35)', color: 'var(--ok)' }}>
        {c.label}
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="chip" style={{ background: 'oklch(0.70 0.13 25 / 0.12)', borderColor: 'oklch(0.70 0.13 25 / 0.35)', color: 'var(--bad)' }}>
        {c.label}
      </span>
    )
  }
  return <span className={c.chipClass}>{c.label}</span>
}
