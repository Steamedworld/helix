import { useEffect, useState } from 'react'
import { listMedia } from '../api/media'
import { listLibraries } from '../api/libraries'
import { getContinueWatching } from '../api/watchstate'
import { useAuth } from '../context/AuthContext'
import type { MediaItem, Library } from '@helix/shared'
import { MediaCard } from '../components/MediaCard'
import { PosterGrid } from '../components/PosterGrid'
import { EmptyState } from '../components/EmptyState'

export function Dashboard() {
  const { user } = useAuth()
  const [recentItems, setRecentItems] = useState<MediaItem[]>([])
  const [continueItems, setContinueItems] = useState<MediaItem[]>([])
  const [libraries, setLibraries] = useState<Library[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      listLibraries(),
      listMedia({ limit: 12 }),
      getContinueWatching(10),
    ]).then(([libRes, mediaRes, continueRes]) => {
      if (libRes.ok) setLibraries(libRes.data)
      if (mediaRes.ok) setRecentItems(mediaRes.data)
      if (continueRes.ok) setContinueItems(continueRes.data)
      setLoading(false)
    })
  }, [])

  if (loading) {
    return (
      <div style={{ color: 'var(--ink-3)', padding: '24px 0' }}>Loading…</div>
    )
  }

  if (libraries.length === 0) {
    if (user?.role === 'admin') {
      return (
        <EmptyState
          title="Welcome to Helix"
          description="Add your first media library to get started. Helix will scan your files and build your catalog automatically."
          ctaLabel="Add a Library"
          ctaHref="/libraries/new"
        />
      )
    }
    return (
      <EmptyState
        title="No libraries available"
        description="You haven't been granted access to any libraries yet. Ask your Helix administrator to grant you access."
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Page header */}
      <div style={{ marginBottom: 40 }}>
        <p className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.14em', marginBottom: 8 }}>
          DASHBOARD
        </p>
        <h1 className="display" style={{ fontSize: 56, lineHeight: 1, letterSpacing: '-0.02em' }}>
          Your <em style={{ fontStyle: 'italic', color: 'var(--accent)' }}>library</em>
        </h1>
        <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>
          {libraries.length} {libraries.length === 1 ? 'library' : 'libraries'} · {recentItems.length} titles
        </p>
      </div>

      {/* Continue Watching */}
      {continueItems.length > 0 && (
        <section style={{ marginBottom: 48 }}>
          <div className="section-head">
            <h2 className="display">Continue <em>watching</em></h2>
            <span className="meta mono" style={{ fontSize: 11, color: 'var(--ink-4)', marginLeft: 'auto' }}>
              {continueItems.length} items
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
            {continueItems.slice(0, 4).map((item) => (
              <MediaCard key={item.id} item={item} variant="wide" />
            ))}
          </div>
        </section>
      )}

      {/* Recently Added */}
      {recentItems.length > 0 && (
        <section>
          <div className="section-head">
            <h2 className="display">Recently <em>added</em></h2>
            <span className="meta mono" style={{ fontSize: 11, color: 'var(--ink-4)', marginLeft: 'auto' }}>
              last 7 days
            </span>
          </div>
          <PosterGrid items={recentItems} />
        </section>
      )}
    </div>
  )
}
