import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getLibrary, triggerScan, getScanStatus } from '../api/libraries'
import { listMedia } from '../api/media'
import type { Library, MediaItem } from '@helix/shared'
import { PosterGrid } from '../components/PosterGrid'
import { EmptyState } from '../components/EmptyState'

const KIND_LABELS: Record<string, string> = {
  movies: 'Movies',
  tv: 'TV',
  music: 'Music',
  photos: 'Photos',
  other: 'Other',
}

export function LibraryDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [library, setLibrary] = useState<Library | null>(null)
  const [items, setItems] = useState<MediaItem[]>([])
  const [itemCount, setItemCount] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function stopPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  async function loadData() {
    if (!id) return
    const [libRes, mediaRes] = await Promise.all([
      getLibrary(id),
      listMedia({ library_id: id, limit: 100 }),
    ])
    if (libRes.ok) {
      setLibrary(libRes.data)
      setScanning(libRes.data.scan_status === 'scanning')
    } else {
      setError(libRes.error)
    }
    if (mediaRes.ok) {
      setItems(mediaRes.data)
      setItemCount(mediaRes.data.length)
    }
    setLoading(false)
  }

  useEffect(() => {
    loadData()
    return () => stopPoll()
  }, [id])

  async function handleScan() {
    if (!id) return
    setScanning(true)
    await triggerScan(id)

    // Poll scan status
    pollRef.current = setInterval(async () => {
      const statusRes = await getScanStatus(id)
      if (statusRes.ok) {
        const { scan_status, item_count } = statusRes.data
        setItemCount(item_count)
        if (scan_status !== 'scanning') {
          setScanning(false)
          stopPoll()
          loadData()
        }
      }
    }, 1500)
  }

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  if (error || !library) {
    return (
      <div style={{ color: 'var(--danger)' }}>
        {error ?? 'Library not found.'}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header */}
      <div>
        <button
          onClick={() => navigate('/libraries')}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            fontSize: 13,
            cursor: 'pointer',
            padding: 0,
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          ← Libraries
        </button>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <h1 style={{ fontSize: 24, fontWeight: 600 }}>{library.name}</h1>
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
                {KIND_LABELS[library.kind] ?? library.kind}
              </span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {library.root_path} · {itemCount} {itemCount === 1 ? 'item' : 'items'}
            </p>
          </div>
          <button
            onClick={handleScan}
            disabled={scanning}
            style={{
              padding: '8px 16px',
              background: scanning ? 'var(--bg-elevated)' : 'var(--accent)',
              color: scanning ? 'var(--text-muted)' : 'white',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontSize: 13,
              fontWeight: 500,
              cursor: scanning ? 'default' : 'pointer',
            }}
          >
            {scanning ? 'Scanning…' : 'Scan Library'}
          </button>
        </div>
      </div>

      {/* Media grid */}
      {items.length === 0 ? (
        <EmptyState
          title="No items yet"
          description="Scan this library to discover media files, or add media files to the library path and scan."
          ctaLabel="Scan Now"
          ctaHref=""
        />
      ) : (
        <PosterGrid items={items} />
      )}
    </div>
  )
}
