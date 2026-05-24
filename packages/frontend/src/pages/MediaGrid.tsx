import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { listMedia } from '../api/media'
import type { MediaItem } from '@helix/shared'
import { PosterGrid } from '../components/PosterGrid'
import { EmptyState } from '../components/EmptyState'

export function MediaGrid() {
  const [searchParams] = useSearchParams()
  const libraryId = searchParams.get('library_id') ?? undefined
  const [items, setItems] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listMedia({ library_id: libraryId, limit: 200 }).then((res) => {
      if (res.ok) setItems(res.data)
      setLoading(false)
    })
  }, [libraryId])

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No media found"
        description="No media items have been added to this library yet."
      />
    )
  }

  return <PosterGrid items={items} />
}
