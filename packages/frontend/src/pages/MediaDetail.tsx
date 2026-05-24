import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getMediaItem } from '../api/media'
import { upsertWatchState } from '../api/watchstate'
import type { MediaItemDetail } from '../api/media'
import type { WatchState } from '@helix/shared'

const DEFAULT_USER_ID = 'default'

function formatBytes(bytes: number | null) {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function MediaDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [item, setItem] = useState<MediaItemDetail | null>(null)
  const [watchState, setWatchState] = useState<WatchState | null>(null)
  const [loading, setLoading] = useState(true)
  const [marking, setMarking] = useState(false)

  useEffect(() => {
    if (!id) return
    getMediaItem(id).then((res) => {
      if (res.ok) setItem(res.data)
      setLoading(false)
    })
  }, [id])

  async function handleMarkWatched() {
    if (!id) return
    setMarking(true)
    const res = await upsertWatchState(id, {
      user_id: DEFAULT_USER_ID,
      position_seconds: item?.versions[0]?.duration_seconds ?? 0,
      duration_seconds: item?.versions[0]?.duration_seconds ?? undefined,
      completed: true,
    })
    setMarking(false)
    if (res.ok) setWatchState(res.data)
  }

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  if (!item) {
    return <div style={{ color: 'var(--danger)' }}>Media item not found.</div>
  }

  const progress = watchState
    ? watchState.duration_seconds
      ? (watchState.position_seconds / watchState.duration_seconds) * 100
      : 0
    : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 800 }}>
      <button
        onClick={() => navigate(-1)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--text-muted)',
          fontSize: 13,
          cursor: 'pointer',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          alignSelf: 'flex-start',
        }}
      >
        ← Back
      </button>

      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700 }}>{item.title}</h1>
          <span
            style={{
              fontSize: 11,
              padding: '3px 8px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--text-muted)',
              fontWeight: 500,
            }}
          >
            {item.kind}
          </span>
        </div>
        {item.year && (
          <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>{item.year}</p>
        )}
      </div>

      {/* Placeholder video player */}
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          aspectRatio: '16/9',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          color: 'var(--text-muted)',
        }}
      >
        <span style={{ fontSize: 40 }}>▶</span>
        <span style={{ fontSize: 14 }}>Video playback coming soon</span>
      </div>

      {/* Watch state */}
      <section>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Watch Progress</h2>
        {watchState ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {progress !== null && (
              <div
                style={{
                  height: 4,
                  background: 'var(--bg-elevated)',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.min(progress, 100)}%`,
                    height: '100%',
                    background: 'var(--accent)',
                  }}
                />
              </div>
            )}
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {watchState.completed ? 'Watched' : `${Math.round(watchState.position_seconds)}s watched`}
            </p>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Not started</p>
        )}
        {!watchState?.completed && (
          <button
            onClick={handleMarkWatched}
            disabled={marking}
            style={{
              marginTop: 12,
              padding: '8px 16px',
              background: 'var(--bg-elevated)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontSize: 13,
              cursor: marking ? 'default' : 'pointer',
              opacity: marking ? 0.6 : 1,
            }}
          >
            {marking ? 'Saving…' : 'Mark as Watched'}
          </button>
        )}
      </section>

      {/* Versions */}
      {item.versions.length > 0 && (
        <section>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Versions</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {item.versions.map((v) => (
              <div
                key={v.id}
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: '12px 16px',
                  display: 'flex',
                  gap: 16,
                  flexWrap: 'wrap',
                  fontSize: 13,
                }}
              >
                <span style={{ color: 'var(--text)' }}>{v.label ?? 'Default'}</span>
                {v.container && <span style={{ color: 'var(--text-muted)' }}>{v.container.toUpperCase()}</span>}
                {v.quality_label && <span style={{ color: 'var(--text-muted)' }}>{v.quality_label}</span>}
                {v.resolution_width && v.resolution_height && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {v.resolution_width}×{v.resolution_height}
                  </span>
                )}
                {v.video_codec && <span style={{ color: 'var(--text-muted)' }}>{v.video_codec}</span>}
                {v.duration_seconds && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {Math.floor(v.duration_seconds / 60)}m {Math.round(v.duration_seconds % 60)}s
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Files */}
      {item.files.length > 0 && (
        <section>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Files</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {item.files.map((f) => (
              <div
                key={f.id}
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: '12px 16px',
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--text)',
                    wordBreak: 'break-all',
                    marginBottom: 4,
                  }}
                >
                  {f.path}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 12 }}>
                  <span>{f.extension.toUpperCase()}</span>
                  <span>{formatBytes(f.size_bytes)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
