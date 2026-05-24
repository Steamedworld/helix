import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { listLibraries } from '../api/libraries'
import type { Library } from '@helix/shared'
import { EmptyState } from '../components/EmptyState'

const KIND_LABELS: Record<string, string> = {
  movies: 'Movies',
  tv: 'TV',
  music: 'Music',
  photos: 'Photos',
  other: 'Other',
}

const SCAN_STATUS_COLORS: Record<string, string> = {
  idle: 'var(--text-muted)',
  scanning: 'var(--accent)',
  error: 'var(--danger)',
}

export function Libraries() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const filterKind = searchParams.get('kind')
  const [libraries, setLibraries] = useState<Library[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listLibraries().then((res) => {
      if (res.ok) {
        setLibraries(res.data)
      }
      setLoading(false)
    })
  }, [])

  const filtered = filterKind
    ? libraries.filter((l) => l.kind === filterKind)
    : libraries

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600 }}>
            {filterKind ? KIND_LABELS[filterKind] ?? filterKind : 'Libraries'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 4 }}>
            {filtered.length} {filtered.length === 1 ? 'library' : 'libraries'}
          </p>
        </div>
        <button
          onClick={() => navigate('/libraries/new')}
          style={{
            padding: '8px 16px',
            background: 'var(--accent)',
            color: 'white',
            border: 'none',
            borderRadius: 'var(--radius)',
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          + Add Library
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No libraries yet"
          description="Add a library to start organizing your media collection."
          ctaLabel="Add your first library"
          ctaHref="/libraries/new"
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {filtered.map((lib) => (
            <div
              key={lib.id}
              onClick={() => navigate(`/libraries/${lib.id}`)}
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)',
                padding: 20,
                cursor: 'pointer',
                transition: 'border-color 0.15s',
              }}
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent)'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  marginBottom: 12,
                }}
              >
                <h3 style={{ fontSize: 16, fontWeight: 600 }}>{lib.name}</h3>
                <span
                  style={{
                    fontSize: 11,
                    padding: '3px 8px',
                    background: 'var(--bg-elevated)',
                    borderRadius: 4,
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                  }}
                >
                  {KIND_LABELS[lib.kind] ?? lib.kind}
                </span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginBottom: 12,
                }}
              >
                {lib.root_path}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: SCAN_STATUS_COLORS[lib.scan_status] ?? 'var(--text-muted)',
                  }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {lib.scan_status === 'scanning'
                    ? 'Scanning…'
                    : lib.scan_status === 'error'
                    ? 'Scan error'
                    : 'Ready'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
