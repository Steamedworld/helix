import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listMedia } from '../api/media'
import { listLibraries } from '../api/libraries'
import { getContinueWatching } from '../api/watchstate'
import type { MediaItem, Library } from '@helix/shared'
import { MediaCard } from '../components/MediaCard'
import { PosterGrid } from '../components/PosterGrid'
import { EmptyState } from '../components/EmptyState'

const DEFAULT_USER_ID = 'default'

export function Dashboard() {
  const navigate = useNavigate()
  const [recentItems, setRecentItems] = useState<MediaItem[]>([])
  const [continueItems, setContinueItems] = useState<MediaItem[]>([])
  const [libraries, setLibraries] = useState<Library[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      listLibraries(),
      listMedia({ limit: 12 }),
      getContinueWatching(DEFAULT_USER_ID, 10),
    ]).then(([libRes, mediaRes, continueRes]) => {
      if (libRes.ok) setLibraries(libRes.data)
      if (mediaRes.ok) setRecentItems(mediaRes.data)
      if (continueRes.ok) setContinueItems(continueRes.data)
      setLoading(false)
    })
  }, [])

  if (loading) {
    return (
      <div style={{ color: 'var(--text-muted)', padding: '24px 0' }}>Loading…</div>
    )
  }

  if (libraries.length === 0) {
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 4 }}>Dashboard</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          {libraries.length} {libraries.length === 1 ? 'library' : 'libraries'} ·{' '}
          {recentItems.length} items
        </p>
      </div>

      {continueItems.length > 0 && (
        <section>
          <h2
            style={{
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 16,
              color: 'var(--text)',
            }}
          >
            Continue Watching
          </h2>
          <div
            style={{
              display: 'flex',
              gap: 16,
              overflowX: 'auto',
              paddingBottom: 8,
            }}
          >
            {continueItems.map((item) => (
              <div key={item.id} style={{ flexShrink: 0, width: 200 }}>
                <MediaCard item={item} compact />
              </div>
            ))}
          </div>
        </section>
      )}

      {recentItems.length > 0 && (
        <section>
          <h2
            style={{
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 16,
              color: 'var(--text)',
            }}
          >
            Recently Added
          </h2>
          <PosterGrid items={recentItems} />
        </section>
      )}
    </div>
  )
}
