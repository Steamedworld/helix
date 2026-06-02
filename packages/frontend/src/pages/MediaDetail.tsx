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
import { usePlaybackRefresh } from '../hooks/usePlaybackRefresh'
import type { MediaItemDetail } from '../api/media'
import type { PlaybackSource, PlaybackCode, LocalPlaybackSource, RemoteDirectPlaybackSource } from '../api/playback'
import type { MetadataCandidate } from '../api/metadata'
import type { PlayableEpisode } from '../api/tv'
import type { WatchState } from '@helix/shared'

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
      className="surface-raised"
      style={{
        position: 'absolute',
        inset: 0,
        background: 'oklch(0.16 0.006 65 / 0.92)',
        borderRadius: 'var(--r-3)',
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
          <p style={{ fontSize: 16, fontWeight: 600, textAlign: 'center', color: 'var(--ink-1)' }}>
            You&apos;ve finished the show!
          </p>
          <button onClick={onDismiss} className="btn">
            Close
          </button>
        </>
      ) : nextEpisode ? (
        <>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', textAlign: 'center' }}>
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
                borderRadius: 'var(--r-2)',
                border: '1px solid var(--line-1)',
              }}
            />
          )}
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 4 }}>
              {nextEpisode.showTitle}
            </p>
            <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-1)' }}>
              S{String(nextEpisode.seasonNumber).padStart(2, '0')}E{String(nextEpisode.episodeNumber).padStart(2, '0')} — {nextEpisode.title}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => {
                if (countdownRef.current) clearInterval(countdownRef.current)
                onPlayNext()
              }}
              className="btn btn-primary"
            >
              Play Next ({countdown}s)
            </button>
            <button
              onClick={() => {
                if (countdownRef.current) clearInterval(countdownRef.current)
                onDismiss()
              }}
              className="btn btn-ghost"
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
  refreshError?: string | null
  isRefreshing?: boolean
  onManualRetry?: () => void
  onProxyError?: () => void
  onSwitchToFallback?: () => void
}

function isLocalSource(source: PlaybackSource): source is LocalPlaybackSource {
  return source.code === 'local_playable'
}

function isRemoteDirectSource(source: PlaybackSource): source is RemoteDirectPlaybackSource {
  return source.code === 'remote_direct'
}

function DirectPlayer({
  source,
  mediaItemId,
  mediaItemKind,
  initialPosition,
  onProgressSaved,
  onEpisodeEnded,
  refreshError,
  onManualRetry,
  onProxyError,
  onSwitchToFallback,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const sessionIdRef = useRef<string | null>(null)
  const lastSavedRef = useRef<number>(0)
  const durationRef = useRef<number | null>(null)
  // Track the stream URL we last applied so we only swap when it actually changes
  const appliedStreamUrlRef = useRef<string | null>(null)

  // For local sources, create a playback session. Remote direct sessions are hub-only
  // (watch state is tracked here on the hub; we do not sync back to the remote node).
  useEffect(() => {
    if (isLocalSource(source)) {
      createPlaybackSession({
        media_item_id: mediaItemId,
        media_version_id: source.versionId,
        media_file_id: source.fileId,
      }).then((res) => {
        if (res.ok) sessionIdRef.current = res.data.id
      })
    }
    // Note: for remote_direct, no playback session is created because we don't have
    // a local mediaFile record. Watch state is still tracked via upsertWatchState below.

    // Cleanup: mark session stopped on unmount
    return () => {
      if (sessionIdRef.current) {
        updatePlaybackSession(sessionIdRef.current, { state: 'stopped' })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaItemId, isLocalSource(source) ? source.fileId : '', isLocalSource(source) ? source.versionId : ''])

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

  // Swap stream URL when a refreshed source arrives — preserves playback position.
  // Does nothing when the URL has not changed (avoids unnecessary interruptions).
  useEffect(() => {
    const video = videoRef.current
    const newUrl = source.streamUrl
    if (!video || newUrl === appliedStreamUrlRef.current) return

    // First application (mount): the <video src=...> attribute handles it; just record it.
    if (appliedStreamUrlRef.current === null) {
      appliedStreamUrlRef.current = newUrl
      return
    }

    // Subsequent change: this is a refreshed URL.
    const savedTime = video.currentTime
    const wasPaused = video.paused

    appliedStreamUrlRef.current = newUrl
    video.src = newUrl

    const onReady = () => {
      video.currentTime = savedTime
      if (!wasPaused) {
        video.play().catch(() => { /* user-gesture restriction — acceptable */ })
      }
      video.removeEventListener('canplay', onReady)
      video.removeEventListener('loadedmetadata', onReady)
    }
    video.addEventListener('canplay', onReady)
    video.addEventListener('loadedmetadata', onReady)
  }, [source.streamUrl])

  const saveProgress = useCallback(
    async (position: number, completed: boolean) => {
      const duration = durationRef.current ?? undefined
      const res = await upsertWatchState(mediaItemId, {
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
    // If this is a proxy stream failure, notify the parent
    if (isRemoteDirectSource(source) && source.proxyStreamUrl && onProxyError) {
      onProxyError()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, onProxyError])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <video
        ref={videoRef}
        src={source.streamUrl}
        controls
        style={{
          width: '100%',
          borderRadius: 'var(--r-3)',
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
          color: 'var(--ink-3)',
          padding: '0 4px',
        }}
      >
        {isRemoteDirectSource(source) ? (
          <>
            <span style={{ color: 'var(--accent)', fontWeight: 500 }}>
              {source.proxyStreamUrl
                ? 'Playing through this Home'
                : `Direct playback from ${source.nodeName}`}
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '2px 8px',
                background: 'rgba(100,120,200,0.10)',
                border: '1px solid rgba(100,120,200,0.25)',
                borderRadius: 10,
                fontSize: 11,
                color: 'var(--ink-3)',
              }}
            >
              <span style={{ opacity: 0.6, fontSize: 9 }}>⬡</span>
              {source.nodeName}
            </span>
            {source.proxyStreamUrl && (
              <span style={{ fontSize: 11, color: 'var(--ink-3)', opacity: 0.7 }}>
                This Home is relaying playback privately
              </span>
            )}
            {source.container && <span>{source.container.toUpperCase()}</span>}
            <span style={{ opacity: 0.5, fontSize: 11 }}>
              Expires {new Date(source.expiresAt).toLocaleTimeString()}
            </span>
          </>
        ) : isLocalSource(source) ? (
          <>
            <span style={{ color: 'var(--accent)', fontWeight: 500 }}>Direct Play from {source.nodeName}.</span>
            <span>{source.filename}</span>
            {source.quality_label && <span>{source.quality_label}</span>}
            {formatResolution(source.resolution_width, source.resolution_height) && (
              <span>{formatResolution(source.resolution_width, source.resolution_height)}</span>
            )}
            {source.container && <span>{source.container.toUpperCase()}</span>}
            {source.video_codec && <span>{source.video_codec}</span>}
          </>
        ) : null}
      </div>
      {/* Informational warning for remote streams pointing to loopback */}
      {isRemoteDirectSource(source) && source.warning && !source.proxyStreamUrl && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--ink-4)',
            padding: '4px 4px 0',
            opacity: 0.8,
            lineHeight: 1.5,
          }}
        >
          {source.warning}
        </div>
      )}
      {/* Fallback button — only shown after proxy error, user-initiated, never auto-applied */}
      {isRemoteDirectSource(source) && source.directStreamUrl && onSwitchToFallback && (
        <div
          style={{
            marginTop: 6,
            padding: '8px 12px',
            background: 'rgba(100,120,200,0.07)',
            border: '1px solid rgba(100,120,200,0.2)',
            borderRadius: 'var(--r-2)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500 }}>
            Try direct playback from Trusted Home
          </span>
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            Your browser may be able to reach that Home directly.
          </span>
          <button
            onClick={onSwitchToFallback}
            className="btn btn-sm btn-ghost"
            style={{ alignSelf: 'flex-start', fontSize: 12, marginTop: 4 }}
          >
            Switch to direct playback
          </button>
        </div>
      )}
      {/* Refresh error — only shown when expiry metadata is present (new server) */}
      {refreshError && source.refreshAfter && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
            color: 'var(--ink-3)',
            padding: '4px 4px 0',
          }}
        >
          <span>{refreshError}</span>
          {onManualRetry && (
            <button
              onClick={onManualRetry}
              className="btn btn-sm btn-ghost"
              style={{ fontSize: 11, padding: '2px 8px' }}
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Unavailable state ─────────────────────────────────────────────────────────

interface PlayerUnavailableProps {
  reason: string
  code?: string | null
  nodeName?: string | null
  isMissing?: boolean
}

function PlayerUnavailable({ reason, code, nodeName, isMissing }: PlayerUnavailableProps) {
  const isRemote =
    code === 'remote_playback_unsupported' || code === 'remote_available'

  if (isRemote) {
    return (
      <div
        style={{
          background: 'var(--bg-3)',
          border: '1px solid var(--line-1)',
          borderRadius: 'var(--r-3)',
          aspectRatio: '16/9',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          color: 'var(--ink-3)',
          padding: 24,
        }}
      >
        <span style={{ fontSize: 28, opacity: 0.5 }}>⊞</span>
        <div style={{ textAlign: 'center' }}>
          {nodeName && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 10px',
                background: 'rgba(100,120,200,0.10)',
                border: '1px solid rgba(100,120,200,0.25)',
                borderRadius: 12,
                fontSize: 12,
                color: 'var(--ink-2)',
                fontWeight: 500,
                marginBottom: 10,
              }}
            >
              <span style={{ opacity: 0.6, fontSize: 10 }}>⬡</span>
              {nodeName}
            </span>
          )}
          <p
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--ink-2)',
              marginBottom: 6,
              textAlign: 'center',
            }}
          >
            Available on {nodeName ?? 'a trusted home'}.
          </p>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', textAlign: 'center' }}>
            This title is available from {nodeName ?? 'a trusted home'}, but direct playback is not
            enabled yet.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        background: 'var(--bg-3)',
        border: `1px solid ${isMissing ? 'var(--bad)' : 'var(--line-1)'}`,
        borderRadius: 'var(--r-3)',
        aspectRatio: '16/9',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        color: 'var(--ink-3)',
      }}
    >
      <span style={{ fontSize: 32 }}>{isMissing ? '⚠' : '⊘'}</span>
      <span style={{ fontSize: 14, fontWeight: 500, color: isMissing ? 'var(--bad)' : undefined }}>
        {isMissing ? 'File went missing' : 'File unavailable'}
      </span>
      <span style={{ fontSize: 12, maxWidth: 340, textAlign: 'center' }}>{reason}</span>
      {isMissing && (
        <span style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
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
        background: 'var(--bg-3)',
        border: '1px solid var(--line-1)',
        borderRadius: 'var(--r-3)',
        aspectRatio: '16/9',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--ink-3)',
        fontSize: 14,
      }}
    >
      Checking playback source…
    </div>
  )
}

// ─── Chip ──────────────────────────────────────────────────────────────────────

function Chip({ label }: { label: string }) {
  return <span className="chip">{label}</span>
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
  const [rawPlaybackSource, setRawPlaybackSource] = useState<PlaybackSource | null>(null)
  const [sourceUnavailable, setSourceUnavailable] = useState<string | null>(null)
  const [sourceCode, setSourceCode] = useState<PlaybackCode | null>(null)
  const [sourceNodeName, setSourceNodeName] = useState<string | null>(null)
  const [sourceLoading, setSourceLoading] = useState(true)
  const [isMissingFile, setIsMissingFile] = useState(false)
  const [proxyError, setProxyError] = useState<string | null>(null)

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
          setSourceCode(data.code)
          setSourceNodeName(data.nodeName ?? null)
          setIsMissingFile(
            data.code === 'unavailable' &&
            typeof data.reason === 'string' &&
            data.reason.toLowerCase().includes('missing')
          )
        } else {
          setRawPlaybackSource(data.source)
          setSourceCode(data.source.code)
        }
      } else {
        setSourceUnavailable('Could not fetch playback source.')
        setSourceCode('unavailable')
      }
      setSourceLoading(false)
    })
  }, [id])

  // Playback refresh: wraps the raw source with proactive token refresh logic.
  // Only active for local and remote_direct sources that carry refreshAfter metadata.
  const refreshableSource =
    rawPlaybackSource?.code === 'local_playable' || rawPlaybackSource?.code === 'remote_direct'
      ? rawPlaybackSource
      : null

  const {
    source: playbackSource,
    refreshError,
    isRefreshing,
  } = usePlaybackRefresh(refreshableSource, id ?? '')

  // Whether user has chosen to switch to direct fallback
  const [usingFallback, setUsingFallback] = useState(false)
  // The active source — may be switched to a fallback version with directStreamUrl as streamUrl
  const [fallbackSource, setFallbackSource] = useState<typeof playbackSource>(null)

  // Proxy error: the local server couldn’t reach the Trusted Home
  function handleProxyError() {
    setProxyError(
      "This Home couldn’t reach the Trusted Home. The remote Home may be offline."
    )
  }

  // User-initiated: switch to direct stream URL (never auto-applied)
  function handleSwitchToFallback() {
    if (!playbackSource) return
    if (playbackSource.code !== 'remote_direct') return
    if (!(playbackSource as RemoteDirectPlaybackSource).directStreamUrl) return
    // Create a patched source that uses directStreamUrl as primary streamUrl
    const switched = {
      ...playbackSource,
      streamUrl: playbackSource.directStreamUrl,
      proxyStreamUrl: undefined,
      refreshUrl: undefined,
      directStreamUrl: undefined,
    }
    setFallbackSource(switched as typeof playbackSource)
    setUsingFallback(true)
    setProxyError(null)
  }

  // Manual retry: re-fetch the playback source from scratch
  function handleManualRetry() {
    if (!id) return
    setSourceLoading(true)
    setSourceUnavailable(null)
    getPlaybackSource(id).then((res) => {
      if (res.ok && !res.data.unavailable && res.data.source) {
        setRawPlaybackSource(res.data.source)
        setSourceCode(res.data.source.code)
      } else if (res.ok && res.data.unavailable) {
        setSourceUnavailable(res.data.reason)
        setSourceCode(res.data.code)
      } else {
        setSourceUnavailable('Could not fetch playback source.')
        setSourceCode('unavailable')
      }
      setSourceLoading(false)
    })
  }

  // Suppress TS unused-var warning — isRefreshing is intentionally unused in render
  void isRefreshing

  async function handleMarkWatched() {
    if (!id) return
    setMarking(true)
    const res = await upsertWatchState(id, {
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
    return <div style={{ color: 'var(--ink-3)' }}>Loading…</div>
  }

  if (!item) {
    return <div style={{ color: 'var(--bad)' }}>Media item not found.</div>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Back button */}
      <button
        onClick={() => navigate(-1)}
        className="btn btn-ghost btn-sm"
        style={{ alignSelf: 'flex-start', marginBottom: 24 }}
      >
        ← Back
      </button>

      {/* Hero backdrop */}
      {backdropUrl && (
        <div
          style={{
            position: 'relative',
            height: 320,
            borderRadius: 'var(--r-4)',
            overflow: 'hidden',
            marginBottom: 0,
          }}
        >
          <img
            src={backdropUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 30%, var(--bg-0) 100%)' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, var(--bg-0) 0%, transparent 60%)' }} />
        </div>
      )}

      {/* Title section */}
      <div
        style={{
          display: 'flex',
          gap: 24,
          alignItems: 'flex-end',
          marginTop: backdropUrl ? -80 : 0,
          position: 'relative',
          zIndex: 2,
          padding: '0 0 24px',
        }}
      >
        {posterUrl && (
          <img
            src={posterUrl}
            alt={item.title}
            style={{
              width: 140,
              aspectRatio: '2/3',
              objectFit: 'cover',
              borderRadius: 'var(--r-3)',
              border: '1px solid var(--line-1)',
              flexShrink: 0,
              boxShadow: 'var(--shadow-2)',
            }}
          />
        )}
        <div style={{ flex: 1, paddingBottom: 8 }}>
          <span className="chip chip-mono" style={{ marginBottom: 10, display: 'inline-flex' }}>{item.kind}</span>
          <h1 className="display" style={{ fontSize: 52, lineHeight: 1, letterSpacing: '-0.02em', marginBottom: 12, color: 'var(--ink-1)' }}>
            {item.title}
          </h1>
          <div className="row gap-3" style={{ marginBottom: 12, fontSize: 13, color: 'var(--ink-2)' }}>
            {item.year && <span className="mono">{item.year}</span>}
            {item.year && item.content_rating && <span className="dot-sep">·</span>}
            {item.content_rating && <span>{item.content_rating}</span>}
          </div>
          {item.overview && (
            <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: 560 }}>
              {item.overview}
            </p>
          )}
        </div>
      </div>

      {/* Metadata chips */}
      {(item.year || item.release_date || item.content_rating) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
          {item.year && <Chip label={String(item.year)} />}
          {item.release_date && !item.year && <Chip label={item.release_date} />}
          {item.content_rating && <Chip label={item.content_rating} />}
        </div>
      )}

      {/* Metadata status + actions */}
      {item.metadata_status === 'needs_review' && (
        <div
          style={{
            padding: '10px 16px',
            background: 'rgba(255, 170, 0, 0.08)',
            border: '1px solid rgba(255, 170, 0, 0.3)',
            borderRadius: 'var(--r-2)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            marginBottom: 16,
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

      {/* Integration links */}
      {item.integrationLinks && item.integrationLinks.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {item.integrationLinks.map((link, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                background: 'rgba(100,120,200,0.08)',
                border: '1px solid rgba(100,120,200,0.25)',
                borderRadius: 4,
                fontSize: 11,
                color: 'var(--ink-3)',
              }}
            >
              <span style={{ fontWeight: 500, color: 'var(--ink-1)' }}>
                Managed by {link.integrationName}
              </span>
              {link.monitored && (
                <span
                  style={{
                    padding: '1px 5px',
                    background: 'rgba(76,175,125,0.12)',
                    borderRadius: 3,
                    color: 'var(--ok)',
                    fontWeight: 500,
                  }}
                >
                  Monitored
                </span>
              )}
              {link.qualityProfile && (
                <span
                  style={{
                    padding: '1px 5px',
                    background: 'var(--bg-3)',
                    border: '1px solid var(--line-1)',
                    borderRadius: 3,
                  }}
                >
                  {link.qualityProfile}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Metadata action row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 24 }}>
        <button
          onClick={handleRefreshMetadata}
          disabled={metadataRefreshing}
          className="btn btn-sm"
          style={{ opacity: metadataRefreshing ? 0.6 : 1 }}
        >
          {metadataRefreshing ? 'Refreshing…' : 'Refresh Metadata'}
        </button>
        {item.metadata_status !== 'needs_review' && (
          <button onClick={handleOpenMatchPanel} className="btn btn-sm">
            Find match
          </button>
        )}
      </div>

      {/* Metadata message */}
      {metadataMessage && (
        <div
          style={{
            padding: '10px 16px',
            background: 'rgba(255, 170, 0, 0.08)',
            border: '1px solid rgba(255, 170, 0, 0.3)',
            borderRadius: 'var(--r-2)',
            fontSize: 13,
            color: '#ffaa00',
            marginBottom: 16,
          }}
        >
          {metadataMessage}
        </div>
      )}

      {/* Match panel */}
      {showMatchPanel && (
        <div
          className="surface"
          style={{ padding: '20px', marginBottom: 24 }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-1)' }}>Find a match</h3>
            <button
              onClick={() => setShowMatchPanel(false)}
              className="btn btn-icon btn-sm btn-ghost"
            >
              ×
            </button>
          </div>

          {candidatesLoading && (
            <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>Searching providers…</p>
          )}

          {!candidatesLoading && candidates !== null && candidates.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>
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
                    background: 'var(--bg-3)',
                    borderRadius: 'var(--r-2)',
                    border: '1px solid var(--line-1)',
                    alignItems: 'flex-start',
                  }}
                >
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
                        background: 'var(--bg-0)',
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
                        color: 'var(--ink-1)',
                      }}
                    >
                      {c.title}
                      {c.year && (
                        <span
                          style={{
                            fontSize: 12,
                            color: 'var(--ink-3)',
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
                          color: 'var(--ink-3)',
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
                          color: 'var(--ink-3)',
                          background: 'var(--bg-0)',
                          padding: '2px 6px',
                          borderRadius: 3,
                        }}
                      >
                        score {(c.score * 100).toFixed(0)}%
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                        {c.providerId}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => handleSelectCandidate(c)}
                    disabled={matchingId === c.externalId}
                    className={`btn btn-sm ${matchingId === c.externalId ? '' : 'btn-primary'}`}
                    style={{ opacity: matchingId === c.externalId ? 0.6 : 1 }}
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
      <section style={{ position: 'relative', marginBottom: 28 }}>
        {sourceLoading ? (
          <PlayerLoading />
        ) : playbackSource ? (
          <>
            <DirectPlayer
              source={usingFallback && fallbackSource ? fallbackSource : playbackSource}
              mediaItemId={item.id}
              mediaItemKind={item.kind}
              initialPosition={savedPosition}
              onProgressSaved={setWatchState}
              onEpisodeEnded={item.kind === 'episode' ? handleEpisodeEnded : undefined}
              refreshError={refreshError}
              onManualRetry={handleManualRetry}
              onProxyError={handleProxyError}
              onSwitchToFallback={
                !usingFallback && playbackSource?.code === 'remote_direct' && playbackSource.directStreamUrl
                  ? handleSwitchToFallback
                  : undefined
              }
            />
            {proxyError && (
              <div
                style={{
                  marginTop: 8,
                  padding: '10px 14px',
                  background: 'rgba(255, 95, 95, 0.08)',
                  border: '1px solid rgba(255, 95, 95, 0.3)',
                  borderRadius: 'var(--r-2)',
                  fontSize: 13,
                  color: 'var(--ink-2)',
                }}
              >
                {proxyError}
              </div>
            )}
          </>
        ) : (
          <PlayerUnavailable
            reason={sourceUnavailable ?? 'Unknown error'}
            code={sourceCode}
            nodeName={sourceNodeName}
            isMissing={isMissingFile}
          />
        )}
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
      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: 'var(--ink-1)' }}>Watch Progress</h2>
        {watchState ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {progress !== null && (
              <div className="bar" style={{ height: 4 }}>
                <i style={{ width: `${Math.min(progress, 100)}%` }} />
              </div>
            )}
            <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>
              {watchState.completed
                ? 'Watched'
                : `${Math.round(watchState.position_seconds)}s watched`}
            </p>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>Not started</p>
        )}
        {!watchState?.completed && (
          <button
            onClick={handleMarkWatched}
            disabled={marking}
            className="btn btn-sm"
            style={{ marginTop: 12, opacity: marking ? 0.6 : 1 }}
          >
            {marking ? 'Saving…' : 'Mark as Watched'}
          </button>
        )}
      </section>

      {/* Versions */}
      {item.versions.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: 'var(--ink-1)' }}>Versions</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {item.versions.map((v) => (
              <div
                key={v.id}
                className="surface"
                style={{
                  padding: '12px 16px',
                  display: 'flex',
                  gap: 16,
                  flexWrap: 'wrap',
                  fontSize: 13,
                }}
              >
                <span style={{ color: 'var(--ink-1)' }}>{v.label ?? 'Default'}</span>
                {v.container && (
                  <span style={{ color: 'var(--ink-3)' }}>{v.container.toUpperCase()}</span>
                )}
                {v.quality_label && (
                  <span style={{ color: 'var(--accent)', fontWeight: 500 }}>{v.quality_label}</span>
                )}
                {v.resolution_width && v.resolution_height && (
                  <span style={{ color: 'var(--ink-3)' }}>
                    {v.resolution_width}×{v.resolution_height}
                  </span>
                )}
                {v.video_codec && (
                  <span style={{ color: 'var(--ink-3)' }}>{v.video_codec}</span>
                )}
                {v.audio_codec && (
                  <span style={{ color: 'var(--ink-3)' }}>{v.audio_codec}</span>
                )}
                {v.duration_seconds != null && (
                  <span style={{ color: 'var(--ink-3)' }}>
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
        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: 'var(--ink-1)' }}>Files</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {item.files.map((f) => (
              <div
                key={f.id}
                className="surface"
                style={{
                  borderColor: f.missing_at ? 'var(--bad)' : undefined,
                  padding: '12px 16px',
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: f.missing_at ? 'var(--bad)' : 'var(--ink-1)',
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
                        border: '1px solid var(--bad)',
                        borderRadius: 3,
                        color: 'var(--bad)',
                      }}
                    >
                      missing
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', display: 'flex', gap: 12 }}>
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
