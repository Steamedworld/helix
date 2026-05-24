import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getMediaItem } from '../api/media'
import { upsertWatchState } from '../api/watchstate'
import {
  getPlaybackSource,
  createPlaybackSession,
  updatePlaybackSession,
} from '../api/playback'
import { searchMetadata, matchMetadata, refreshMetadata } from '../api/metadata'
import { getNextEpisode } from '../api/tv'
import type { MediaItemDetail } from '../api/media'
import type { PlaybackSource } from '../api/playback'
import type { MetadataCandidate } from '../api/metadata'
import type { PlayableEpisode } from '../api/tv'
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

// ─── Up Next panel ─────────────────────────────────────────────────────────────

interface UpNextPanelProps {
  nextEpisode: PlayableEpisode | null
  showFinished: boolean
  onPlayNext: () => void
  onDismiss: () => void
}

function UpNextPanel({ nextEpisode, showFinished, onPlayNext, onDismiss }: UpNextPanelProps) {
  const [countdown, setCountdown] = useState(10)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Start countdown if we have a next episode
  useEffect(() => {
    if (!nextEpisode) return
    countdownRef.current = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) {
          clearInterval(countdownRef.current!)
          onPlayNext()
          return 0
        }
        return n - 1
      })
    }, 1000)
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [nextEpisode, onPlayNext])

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(8, 8, 9, 0.88)',
        borderRadius: 'var(--radius-lg)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 24,
        zIndex: 10,
      }}
    >
      {showFinished ? (
        <>
          <span style={{ fontSize: 32 }}>✓</span>
          <p style={{ fontSize: 16, fontWeight: 600, textAlign: 'center' }}>
            You&apos;ve finished the show!
          </p>
          <button
            onClick={onDismiss}
            style={{
              padding: '8px 20px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              color: 'var(--text)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </>
      ) : nextEpisode ? (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
            Up Next
          </p>
          {nextEpisode.posterUrl && (
            <img
              src={nextEpisode.posterUrl}
              alt={nextEpisode.title}
              style={{
                width: 120,
                aspectRatio: '16/9',
                objectFit: 'cover',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
              }}
            />
          )}
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
              {nextEpisode.showTitle}
            </p>
            <p style={{ fontSize: 15, fontWeight: 600 }}>
              S{String(nextEpisode.seasonNumber).padStart(2, '0')}E{String(nextEpisode.episodeNumber).padStart(2, '0')} — {nextEpisode.title}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => {
                if (countdownRef.current) clearInterval(countdownRef.current)
                onPlayNext()
              }}
              style={{
                padding: '8px 20px',
                background: 'var(--accent)',
                border: 'none',
                borderRadius: 'var(--radius)',
                color: '#fff',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Play Next ({countdown}s)
            </button>
            <button
              onClick={() => {
                if (countdownRef.current) clearInterval(countdownRef.current)
                onDismiss()
              }}
              style={{
                padding: '8px 16px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                color: 'var(--text-muted)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

// ─── Inline video player ───────────────────────────────────────────────────────

interface PlayerProps {
  source: PlaybackSource
  mediaItemId: string
  mediaItemKind: string
  initialPosition: number
  onProgressSaved: (ws: WatchState) => void
  onEpisodeEnded?: (nextEpisode: PlayableEpisode | null, showFinished: boolean) => void
}

function DirectPlayer({
  source,
  mediaItemId,
  mediaItemKind,
  initialPosition,
  onProgressSaved,
  onEpisodeEnded,
}: PlayerProps) {
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

  const handleEnded = useCallback(async () => {
    const video = videoRef.current
    if (!video) return

    if (sessionIdRef.current) {
      updatePlaybackSession(sessionIdRef.current, { state: 'stopped' })
    }
    // Mark episode/movie as completed
    await saveProgress(video.currentTime, true)

    // Only fetch next episode for episode items
    if (mediaItemKind === 'episode' && onEpisodeEnded) {
      const res = await getNextEpisode(mediaItemId)
      if (res.ok) {
        onEpisodeEnded(res.data.episode, false)
      } else {
        // 404 = no next episode (show finished)
        onEpisodeEnded(null, true)
      }
    }
  }, [saveProgress, mediaItemId, mediaItemKind, onEpisodeEnded])

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

function PlayerUnavailable({ reason, isMissing }: { reason: string; isMissing?: boolean }) {
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: `1px solid ${isMissing ? 'var(--danger)' : 'var(--border)'}`,
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
      <span style={{ fontSize: 32 }}>{isMissing ? '⚠' : '⊘'}</span>
      <span style={{ fontSize: 14, fontWeight: 500, color: isMissing ? 'var(--danger)' : undefined }}>
        {isMissing ? 'File went missing' : 'File unavailable'}
      </span>
      <span style={{ fontSize: 12, maxWidth: 340, textAlign: 'center' }}>{reason}</span>
      {isMissing && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          Re-scan the library to update file status.
        </span>
      )}
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

// ─── Chip ──────────────────────────────────────────────────────────────────────

function Chip({ label }: { label: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 8px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        color: 'var(--text-muted)',
        fontWeight: 500,
      }}
    >
      {label}
    </span>
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
  const [isMissingFile, setIsMissingFile] = useState(false)

  // Up Next panel (episodes only)
  const [upNextEpisode, setUpNextEpisode] = useState<PlayableEpisode | null>(null)
  const [showFinished, setShowFinished] = useState(false)
  const [showUpNextPanel, setShowUpNextPanel] = useState(false)

  // Metadata
  const [metadataRefreshing, setMetadataRefreshing] = useState(false)
  const [metadataMessage, setMetadataMessage] = useState<string | null>(null)
  const [showMatchPanel, setShowMatchPanel] = useState(false)
  const [candidates, setCandidates] = useState<MetadataCandidate[] | null>(null)
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [matchingId, setMatchingId] = useState<string | null>(null)

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
          // Detect the "went missing" case by looking for the specific reason text
          setIsMissingFile(
            typeof data.reason === 'string' &&
            data.reason.toLowerCase().includes('missing')
          )
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

  // Called by DirectPlayer when an episode ends
  function handleEpisodeEnded(next: PlayableEpisode | null, finished: boolean) {
    setUpNextEpisode(next)
    setShowFinished(finished)
    setShowUpNextPanel(true)
  }

  // Navigate to the next episode page
  function handlePlayNext() {
    if (!upNextEpisode) return
    setShowUpNextPanel(false)
    setUpNextEpisode(null)
    setShowFinished(false)
    navigate(`/media/${upNextEpisode.id}`)
  }

  function handleDismissUpNext() {
    setShowUpNextPanel(false)
    setUpNextEpisode(null)
    setShowFinished(false)
  }

  async function handleRefreshMetadata() {
    if (!id) return
    setMetadataRefreshing(true)
    setMetadataMessage(null)
    const res = await refreshMetadata(id)
    setMetadataRefreshing(false)
    if (res.ok) {
      const result = res.data as any
      if (result.status === 'parent_unmatched') {
        setMetadataMessage(result.message ?? 'Match the parent show first to enable episode enrichment.')
      } else {
        // Reload the item to pick up updated fields
        const itemRes = await getMediaItem(id)
        if (itemRes.ok) setItem(itemRes.data)
      }
    }
  }

  async function handleOpenMatchPanel() {
    if (!id) return
    setShowMatchPanel(true)
    if (candidates === null) {
      setCandidatesLoading(true)
      const res = await searchMetadata(id)
      setCandidatesLoading(false)
      if (res.ok) setCandidates(res.data.candidates)
      else setCandidates([])
    }
  }

  async function handleSelectCandidate(candidate: MetadataCandidate) {
    if (!id) return
    setMatchingId(candidate.externalId)
    const res = await matchMetadata(id, candidate.providerId, candidate.externalId)
    setMatchingId(null)
    if (res.ok) {
      setShowMatchPanel(false)
      setCandidates(null)
      const itemRes = await getMediaItem(id)
      if (itemRes.ok) setItem(itemRes.data)
    }
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

  const backdropUrl = item.backdropUrl ?? null
  const posterUrl = item.posterUrl ?? null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 860 }}>
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

      {/* Hero backdrop */}
      {backdropUrl && (
        <div
          style={{
            width: '100%',
            aspectRatio: '16/5',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <img
            src={backdropUrl}
            alt=""
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              opacity: 0.6,
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(to bottom, transparent 40%, var(--bg) 100%)',
            }}
          />
        </div>
      )}

      {/* Header — poster + title info */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {posterUrl && (
          <img
            src={posterUrl}
            alt={item.title}
            style={{
              width: 100,
              aspectRatio: '2/3',
              objectFit: 'cover',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border)',
              flexShrink: 0,
            }}
          />
        )}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
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
          {/* Metadata chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {item.year && <Chip label={String(item.year)} />}
            {item.release_date && !item.year && <Chip label={item.release_date} />}
            {item.content_rating && <Chip label={item.content_rating} />}
          </div>
          {/* Overview */}
          {item.overview && (
            <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 600 }}>
              {item.overview}
            </p>
          )}
        </div>
      </div>

      {/* Metadata status + actions */}
      {item.metadata_status === 'needs_review' && (
        <div
          style={{
            padding: '10px 16px',
            background: 'rgba(255, 170, 0, 0.08)',
            border: '1px solid rgba(255, 170, 0, 0.3)',
            borderRadius: 'var(--radius)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 13, color: '#ffaa00', fontWeight: 500 }}>
            Needs Review — metadata match is uncertain
          </span>
          <button
            onClick={handleOpenMatchPanel}
            style={{
              fontSize: 12,
              padding: '4px 12px',
              background: 'rgba(255, 170, 0, 0.15)',
              border: '1px solid rgba(255, 170, 0, 0.4)',
              borderRadius: 4,
              color: '#ffaa00',
              cursor: 'pointer',
            }}
          >
            Find match
          </button>
        </div>
      )}

      {/* Metadata action row — refresh button (always visible) */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={handleRefreshMetadata}
          disabled={metadataRefreshing}
          style={{
            fontSize: 12,
            padding: '5px 12px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            color: 'var(--text-muted)',
            cursor: metadataRefreshing ? 'default' : 'pointer',
            opacity: metadataRefreshing ? 0.6 : 1,
          }}
        >
          {metadataRefreshing ? 'Refreshing…' : 'Refresh Metadata'}
        </button>
        {item.metadata_status !== 'needs_review' && (
          <button
            onClick={handleOpenMatchPanel}
            style={{
              fontSize: 12,
              padding: '5px 12px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--text-muted)',
              cursor: 'pointer',
            }}
          >
            Find match
          </button>
        )}
      </div>

      {/* Metadata message (e.g. parent_unmatched for episodes) */}
      {metadataMessage && (
        <div
          style={{
            padding: '10px 16px',
            background: 'rgba(255, 170, 0, 0.08)',
            border: '1px solid rgba(255, 170, 0, 0.3)',
            borderRadius: 'var(--radius)',
            fontSize: 13,
            color: '#ffaa00',
          }}
        >
          {metadataMessage}
        </div>
      )}

      {/* Match panel */}
      {showMatchPanel && (
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '20px',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            <h3 style={{ fontSize: 15, fontWeight: 600 }}>Find a match</h3>
            <button
              onClick={() => setShowMatchPanel(false)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: 20,
                cursor: 'pointer',
                lineHeight: 1,
                padding: '0 4px',
              }}
            >
              ×
            </button>
          </div>

          {candidatesLoading && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Searching providers…</p>
          )}

          {!candidatesLoading && candidates !== null && candidates.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              No candidates found. Check that a metadata provider is configured.
            </p>
          )}

          {!candidatesLoading && candidates && candidates.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {candidates.slice(0, 8).map((c) => (
                <div
                  key={`${c.providerId}:${c.externalId}`}
                  style={{
                    display: 'flex',
                    gap: 12,
                    padding: '12px',
                    background: 'var(--bg-elevated)',
                    borderRadius: 'var(--radius)',
                    border: '1px solid var(--border)',
                    alignItems: 'flex-start',
                  }}
                >
                  {/* Poster thumbnail */}
                  {c.posterUrl ? (
                    <img
                      src={c.posterUrl}
                      alt={c.title}
                      style={{
                        width: 48,
                        aspectRatio: '2/3',
                        objectFit: 'cover',
                        borderRadius: 4,
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 48,
                        aspectRatio: '2/3',
                        background: 'var(--bg)',
                        borderRadius: 4,
                        flexShrink: 0,
                      }}
                    />
                  )}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        marginBottom: 2,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {c.title}
                      {c.year && (
                        <span
                          style={{
                            fontSize: 12,
                            color: 'var(--text-muted)',
                            fontWeight: 400,
                            marginLeft: 6,
                          }}
                        >
                          ({c.year})
                        </span>
                      )}
                    </div>
                    {c.overview && (
                      <p
                        style={{
                          fontSize: 12,
                          color: 'var(--text-muted)',
                          lineHeight: 1.5,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical' as const,
                          overflow: 'hidden',
                          marginBottom: 4,
                        }}
                      >
                        {c.overview}
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--text-muted)',
                          background: 'var(--bg)',
                          padding: '2px 6px',
                          borderRadius: 3,
                        }}
                      >
                        score {(c.score * 100).toFixed(0)}%
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {c.providerId}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => handleSelectCandidate(c)}
                    disabled={matchingId === c.externalId}
                    style={{
                      flexShrink: 0,
                      fontSize: 12,
                      padding: '6px 14px',
                      background:
                        matchingId === c.externalId
                          ? 'var(--bg-elevated)'
                          : 'var(--accent)',
                      border: 'none',
                      borderRadius: 4,
                      color: matchingId === c.externalId ? 'var(--text-muted)' : '#fff',
                      cursor: matchingId === c.externalId ? 'default' : 'pointer',
                      opacity: matchingId === c.externalId ? 0.6 : 1,
                      alignSelf: 'center',
                    }}
                  >
                    {matchingId === c.externalId ? 'Saving…' : 'Select'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Player area */}
      <section style={{ position: 'relative' }}>
        {sourceLoading ? (
          <PlayerLoading />
        ) : playbackSource ? (
          <DirectPlayer
            source={playbackSource}
            mediaItemId={item.id}
            mediaItemKind={item.kind}
            initialPosition={savedPosition}
            onProgressSaved={setWatchState}
            onEpisodeEnded={item.kind === 'episode' ? handleEpisodeEnded : undefined}
          />
        ) : (
          <PlayerUnavailable
            reason={sourceUnavailable ?? 'Unknown error'}
            isMissing={isMissingFile}
          />
        )}
        {/* Up Next / Show Finished overlay */}
        {showUpNextPanel && (
          <UpNextPanel
            nextEpisode={upNextEpisode}
            showFinished={showFinished}
            onPlayNext={handlePlayNext}
            onDismiss={handleDismissUpNext}
          />
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
                  <span style={{ color: 'var(--accent)', fontWeight: 500 }}>{v.quality_label}</span>
                )}
                {v.resolution_width && v.resolution_height && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {v.resolution_width}×{v.resolution_height}
                  </span>
                )}
                {v.video_codec && (
                  <span style={{ color: 'var(--text-muted)' }}>{v.video_codec}</span>
                )}
                {v.audio_codec && (
                  <span style={{ color: 'var(--text-muted)' }}>{v.audio_codec}</span>
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
                  border: `1px solid ${f.missing_at ? 'var(--danger)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)',
                  padding: '12px 16px',
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: f.missing_at ? 'var(--danger)' : 'var(--text)',
                    wordBreak: 'break-all',
                    marginBottom: 4,
                  }}
                >
                  {f.filename}
                  {f.missing_at && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        padding: '1px 6px',
                        background: 'rgba(255,95,95,0.12)',
                        border: '1px solid var(--danger)',
                        borderRadius: 3,
                        color: 'var(--danger)',
                      }}
                    >
                      missing
                    </span>
                  )}
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
