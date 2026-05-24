import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getMediaItem } from '../api/media'
import { upsertWatchState } from '../api/watchstate'
import {
  getPlaybackSource,
  createPlaybackSession,
  updatePlaybackSession,
} from '../api/playback'
import type { MediaItemDetail } from '../api/media'
import type { PlaybackSource } from '../api/playback'
import type { WatchState } from '@helix/shared'

const DEFAULT_USER_ID = 'default'
// Save progress at most every N milliseconds
const SAVE_DEBOUNCE_MS = 5000
// Mark completed when this fraction of the video has been watched
const COMPLETION_THRESHOLD = 0.9

function formatBytes(bytes: number | null) {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatResolution(w: number | null, h: number | null) {
  if (!w || !h) return null
  return `${w}×${h}`
}

function formatDuration(seconds: number | null) {
  if (!seconds) return null
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.round(seconds % 60)
  if (h > 0) return `${h}h ${m}m ${s}s`
  return `${m}m ${s}s`
}

// ─── Inline video player ───────────────────────────────────────────────────────

interface PlayerProps {
  source: PlaybackSource
  mediaItemId: string
  initialPosition: number
  onProgressSaved: (ws: WatchState) => void
}

function DirectPlayer({ source, mediaItemId, initialPosition, onProgressSaved }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const sessionIdRef = useRef<string | null>(null)
  const lastSavedRef = useRef<number>(0)
  const durationRef = useRef<number | null>(null)

  // Create session on mount
  useEffect(() => {
    createPlaybackSession({
      media_item_id: mediaItemId,
      media_version_id: source.versionId,
      media_file_id: source.fileId,
    }).then((res) => {
      if (res.ok) sessionIdRef.current = res.data.id
    })

    // Cleanup: mark session stopped on unmount
    return () => {
      if (sessionIdRef.current) {
        updatePlaybackSession(sessionIdRef.current, { state: 'stopped' })
      }
    }
  }, [mediaItemId, source.fileId, source.versionId])

  // Seek to saved position once video is ready
  useEffect(() => {
    const video = videoRef.current
    if (!video || initialPosition <= 0) return

    const onLoadedMetadata = () => {
      video.currentTime = initialPosition
    }
    video.addEventListener('loadedmetadata', onLoadedMetadata)
    return () => video.removeEventListener('loadedmetadata', onLoadedMetadata)
  }, [initialPosition])

  const saveProgress = useCallback(
    async (position: number, completed: boolean) => {
      const duration = durationRef.current ?? undefined
      const res = await upsertWatchState(mediaItemId, {
        user_id: DEFAULT_USER_ID,
        position_seconds: position,
        duration_seconds: duration,
        completed,
      })
      if (res.ok) onProgressSaved(res.data)
    },
    [mediaItemId, onProgressSaved]
  )

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    durationRef.current = video.duration || null
    const now = Date.now()
    if (now - lastSavedRef.current < SAVE_DEBOUNCE_MS) return
    lastSavedRef.current = now

    const position = video.currentTime
    const duration = video.duration
    const completed = duration > 0 && position / duration >= COMPLETION_THRESHOLD

    saveProgress(position, completed)
  }, [saveProgress])

  const handlePlay = useCallback(() => {
    if (sessionIdRef.current) {
      updatePlaybackSession(sessionIdRef.current, { state: 'playing' })
    }
  }, [])

  const handlePause = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    if (sessionIdRef.current) {
      updatePlaybackSession(sessionIdRef.current, { state: 'paused' })
    }
    // Save position on pause
    const duration = video.duration || null
    durationRef.current = duration
    const completed = duration !== null && video.currentTime / duration >= COMPLETION_THRESHOLD
    saveProgress(video.currentTime, completed)
  }, [saveProgress])

  const handleEnded = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    if (sessionIdRef.current) {
      updatePlaybackSession(sessionIdRef.current, { state: 'stopped' })
    }
    saveProgress(video.currentTime, true)
  }, [saveProgress])

  const handleError = useCallback(() => {
    if (sessionIdRef.current) {
      updatePlaybackSession(sessionIdRef.current, { state: 'error' })
    }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <video
        ref={videoRef}
        src={source.streamUrl}
        controls
        style={{
          width: '100%',
          borderRadius: 'var(--radius-lg)',
          background: '#000',
          display: 'block',
        }}
        onTimeUpdate={handleTimeUpdate}
        onPlay={handlePlay}
        onPause={handlePause}
        onEnded={handleEnded}
        onError={handleError}
      />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          fontSize: 12,
          color: 'var(--text-muted)',
          padding: '0 4px',
        }}
      >
        <span style={{ color: 'var(--accent)', fontWeight: 500 }}>Direct Play from Helix Local.</span>
        <span>{source.filename}</span>
        {source.quality_label && <span>{source.quality_label}</span>}
        {formatResolution(source.resolution_width, source.resolution_height) && (
          <span>{formatResolution(source.resolution_width, source.resolution_height)}</span>
        )}
        {source.container && <span>{source.container.toUpperCase()}</span>}
        {source.video_codec && <span>{source.video_codec}</span>}
      </div>
    </div>
  )
}

// ─── Unavailable state ─────────────────────────────────────────────────────────

function PlayerUnavailable({ reason }: { reason: string }) {
  return (
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
      <span style={{ fontSize: 32 }}>⊘</span>
      <span style={{ fontSize: 14, fontWeight: 500 }}>File unavailable</span>
      <span style={{ fontSize: 12, maxWidth: 300, textAlign: 'center' }}>{reason}</span>
    </div>
  )
}

// ─── Loading state ─────────────────────────────────────────────────────────────

function PlayerLoading() {
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        aspectRatio: '16/9',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        fontSize: 14,
      }}
    >
      Checking playback source…
    </div>
  )
}

// ─── MediaDetail page ──────────────────────────────────────────────────────────

export function MediaDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [item, setItem] = useState<MediaItemDetail | null>(null)
  const [watchState, setWatchState] = useState<WatchState | null>(null)
  const [loading, setLoading] = useState(true)
  const [marking, setMarking] = useState(false)

  // Playback source
  const [playbackSource, setPlaybackSource] = useState<PlaybackSource | null>(null)
  const [sourceUnavailable, setSourceUnavailable] = useState<string | null>(null)
  const [sourceLoading, setSourceLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    getMediaItem(id).then((res) => {
      if (res.ok) setItem(res.data)
      setLoading(false)
    })
  }, [id])

  useEffect(() => {
    if (!id) return
    setSourceLoading(true)
    getPlaybackSource(id).then((res) => {
      if (res.ok) {
        const data = res.data
        if (data.unavailable) {
          setSourceUnavailable(data.reason)
        } else {
          setPlaybackSource(data.source)
        }
      } else {
        setSourceUnavailable('Could not fetch playback source.')
      }
      setSourceLoading(false)
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

  const savedPosition = watchState && !watchState.completed ? watchState.position_seconds : 0

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

      {/* Player area */}
      <section>
        {sourceLoading ? (
          <PlayerLoading />
        ) : playbackSource ? (
          <DirectPlayer
            source={playbackSource}
            mediaItemId={item.id}
            initialPosition={savedPosition}
            onProgressSaved={setWatchState}
          />
        ) : (
          <PlayerUnavailable reason={sourceUnavailable ?? 'Unknown error'} />
        )}
      </section>

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
              {watchState.completed
                ? 'Watched'
                : `${Math.round(watchState.position_seconds)}s watched`}
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
                {v.container && (
                  <span style={{ color: 'var(--text-muted)' }}>{v.container.toUpperCase()}</span>
                )}
                {v.quality_label && (
                  <span style={{ color: 'var(--text-muted)' }}>{v.quality_label}</span>
                )}
                {v.resolution_width && v.resolution_height && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {v.resolution_width}×{v.resolution_height}
                  </span>
                )}
                {v.video_codec && (
                  <span style={{ color: 'var(--text-muted)' }}>{v.video_codec}</span>
                )}
                {v.duration_seconds != null && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {formatDuration(v.duration_seconds)}
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
