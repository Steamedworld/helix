import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { listShows } from '../api/tv'
import type { ShowListItem } from '../api/tv'
import { EmptyState } from '../components/EmptyState'

function ShowCard({ show }: { show: ShowListItem }) {
  const navigate = useNavigate()
  const [imgError, setImgError] = useState(false)
  const showImage = show.posterUrl && !imgError

  return (
    <div
      onClick={() => navigate(`/shows/${show.id}`)}
      style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div
        style={{
          width: '100%',
          aspectRatio: '2/3',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: 36,
          position: 'relative',
          transition: 'border-color 0.15s',
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent)'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'
        }}
      >
        {showImage ? (
          <img
            src={show.posterUrl!}
            alt={show.title}
            onError={() => setImgError(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <span>▭</span>
        )}
        {/* Episode count badge */}
        {show.episodeCount > 0 && (
          <div
            style={{
              position: 'absolute',
              bottom: 6,
              right: 6,
              background: 'rgba(0,0,0,0.7)',
              color: 'var(--text-muted)',
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 3,
              fontWeight: 500,
            }}
          >
            {show.episodeCount} ep
          </div>
        )}
      </div>
      <div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {show.title}
        </div>
        {show.year && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{show.year}</div>}
      </div>
    </div>
  )
}

export function Shows() {
  const [searchParams] = useSearchParams()
  const libraryId = searchParams.get('library_id') ?? undefined
  const [shows, setShows] = useState<ShowListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    listShows(libraryId).then((res) => {
      if (res.ok) setShows(res.data)
      setLoading(false)
    })
  }, [libraryId])

  if (loading) {
    return <div style={{ color: 'var(--text-muted)', padding: '24px 0' }}>Loading…</div>
  }

  const filtered = query
    ? shows.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
    : shows

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>TV Shows</h1>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {shows.length} {shows.length === 1 ? 'show' : 'shows'}
        </span>
        <input
          type="text"
          placeholder="Filter shows…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            marginLeft: 'auto',
            padding: '6px 12px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text)',
            fontSize: 13,
            outline: 'none',
            width: 200,
          }}
        />
      </div>

      {filtered.length === 0 ? (
        shows.length === 0 ? (
          <EmptyState
            title="No TV shows found"
            description="Add a TV library and scan it to discover your shows."
            ctaLabel="Add a Library"
            ctaHref="/libraries/new"
          />
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            No shows match "{query}".
          </div>
        )
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: 20,
          }}
        >
          {filtered.map((show) => (
            <ShowCard key={show.id} show={show} />
          ))}
        </div>
      )}
    </div>
  )
}
