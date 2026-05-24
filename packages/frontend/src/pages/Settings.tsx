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
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 4 }}>Settings</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          Helix configuration and provider status.
        </p>
      </div>

      {/* Metadata providers */}
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Metadata Providers</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Providers enrich your media catalog with titles, overviews, artwork, and ratings.
          Configure credentials via environment variables on the backend.
        </p>

        {loading && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading providers…</p>
        )}

        {!loading && providers !== null && providers.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No providers registered.</p>
        )}

        {!loading && providers && providers.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {providers.map((p) => (
              <div
                key={p.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 16px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{p.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
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
          style={{
            marginTop: 16,
            padding: '12px 16px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            fontSize: 12,
            color: 'var(--text-muted)',
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: 'var(--text)' }}>TMDB setup:</strong> Get a free API key at{' '}
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
            style={{
              background: 'var(--bg)',
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
  const colors: Record<ProviderInfo['status'], { bg: string; text: string; label: string }> = {
    configured: { bg: 'rgba(76,175,125,0.12)', text: '#4caf7d', label: 'Configured' },
    unconfigured: { bg: 'rgba(122,122,138,0.12)', text: 'var(--text-muted)', label: 'Not configured' },
    error: { bg: 'rgba(255,95,95,0.12)', text: 'var(--danger)', label: 'Error' },
  }
  const style = colors[status]
  return (
    <span
      style={{
        fontSize: 11,
        padding: '3px 8px',
        background: style.bg,
        borderRadius: 4,
        color: style.text,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {style.label}
    </span>
  )
}
