import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { listLibraries } from '../api/libraries'
import type { Library } from '@helix/shared'
import { EmptyState } from '../components/EmptyState'
import { IconFilm, IconTv, IconList } from '../components/Icons'

const KIND_LABELS: Record<string, string> = {
  movies: 'Movies',
  tv: 'TV',
  music: 'Music',
  photos: 'Photos',
  other: 'Other',
}

const SCAN_STATUS_COLORS: Record<string, string> = {
  idle: 'var(--ink-4)',
  scanning: 'var(--accent)',
  error: 'var(--bad)',
}

function LibraryIcon({ kind }: { kind: string }) {
  if (kind === 'movies') return <IconFilm size={20} style={{ color: 'var(--ink-3)' }} />
  if (kind === 'tv') return <IconTv size={20} style={{ color: 'var(--ink-3)' }} />
  return <IconList size={20} style={{ color: 'var(--ink-3)' }} />
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
    return <div style={{ color: 'var(--ink-3)' }}>Loading…</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Page header */}
      <div style={{ marginBottom: 8 }}>
        <p className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.14em', marginBottom: 6 }}>
          LIBRARIES
        </p>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <h1 className="display" style={{ fontSize: 48, lineHeight: 1, letterSpacing: '-0.02em' }}>
            Your <em style={{ color: 'var(--accent)', fontStyle: 'italic' }}>collection</em>
          </h1>
          <button
            onClick={() => navigate('/libraries/new')}
            className="btn btn-primary"
            style={{ marginBottom: 4 }}
          >
            + Add Library
          </button>
        </div>
        {filterKind && (
          <p className="muted" style={{ fontSize: 14, marginTop: 6 }}>
            Showing: {KIND_LABELS[filterKind] ?? filterKind} · {filtered.length} {filtered.length === 1 ? 'library' : 'libraries'}
          </p>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No libraries yet"
          description="Add a library to start organizing your media collection."
          ctaLabel="Add your first library"
          ctaHref="/libraries/new"
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map((lib) => (
            <div
              key={lib.id}
              className="surface"
              onClick={() => navigate(`/libraries/${lib.id}`)}
              style={{
                padding: 20,
                display: 'flex',
                gap: 24,
                cursor: 'pointer',
                transition: 'border-color var(--d-fast) var(--ease)',
              }}
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent-line)'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--line-1)'
              }}
            >
              {/* Icon square */}
              <div
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 'var(--r-3)',
                  background: 'var(--bg-3)',
                  border: '1px solid var(--line-1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <LibraryIcon kind={lib.kind} />
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                  <h3 className="display" style={{ fontSize: 20, lineHeight: 1 }}>{lib.name}</h3>
                  <span className="chip chip-mono">{KIND_LABELS[lib.kind] ?? lib.kind}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto' }}>
                    <div
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: SCAN_STATUS_COLORS[lib.scan_status] ?? 'var(--ink-4)',
                      }}
                    />
                    <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                      {lib.scan_status === 'scanning'
                        ? 'Scanning…'
                        : lib.scan_status === 'error'
                        ? 'Scan error'
                        : 'Ready'}
                    </span>
                  </div>
                </div>
                <div className="kv" style={{ gap: 0 }}>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>PATH</span>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--ink-3)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {lib.root_path}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0 }}>
                <button
                  className="btn btn-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/libraries/${lib.id}`)
                  }}
                >
                  View
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
