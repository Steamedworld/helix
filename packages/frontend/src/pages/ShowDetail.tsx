import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getShow, getSeasonEpisodes, getShowUpNext, getShowProgress } from '../api/tv'
import { searchMetadata, matchMetadata, refreshMetadata } from '../api/metadata'
import type {
  ShowDetail as ShowDetailType,
  SeasonSummary,
  EpisodeListItem,
  PlayableEpisode,
  ShowProgressData,
  UpNextResponse,
} from '../api/tv'
import type { MetadataCandidate } from '../api/metadata'

function formatDuration(seconds: number | null): string {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  return `${m}m`
}

function EpisodeRow({
  ep,
  onClick,
  unavailable = false,
}: {
  ep: EpisodeListItem
  onClick: () => void
  unavailable?: boolean
}) {
  const ws = ep.watchState
  const progress =
    ws && ws.duration_seconds && ws.duration_seconds > 0
      ? (ws.position_seconds / ws.duration_seconds) * 100
      : null

  const minutesLeft =
    ws && !ws.completed && ws.duration_seconds && ws.position_seconds > 0
      ? Math.ceil((ws.duration_seconds - ws.position_seconds) / 60)
      : null

  return (
    <div
      onClick={unavailable ? undefined : onClick}
      style={{
        display: 'flex',
        gap: 14,
        padding: '14px 0',
        borderBottom: '1px solid var(--line-1)',
        cursor: unavailable ? 'default' : 'pointer',
        alignItems: 'flex-start',
        opacity: unavailable ? 0.5 : 1,
      }}
    >
      {/* Episode thumbnail placeholder */}
      <div
        style={{
          flexShrink: 0,
          width: 120,
          height: 68,
          borderRadius: 'var(--r-2)',
          overflow: 'hidden',
          background: 'var(--bg-3)',
          border: '1px solid var(--line-1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-4)' }}>
          {ep.episodeNumber}
        </span>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, flexWrap: 'wrap' }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>
            E{String(ep.episodeNumber).padStart(2, '0')}
          </span>
          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-1)' }}>
            {ep.episodeTitle ?? ep.title}
          </span>
          {ws?.completed && (
            <span className="chip chip-accent" style={{ height: 18, fontSize: 10 }}>
              ✓ Watched
            </span>
          )}
          {minutesLeft !== null && (
            <span className="chip chip-accent" style={{ height: 18, fontSize: 10 }}>
              {minutesLeft}min left
            </span>
          )}
          {unavailable && (
            <span className="chip" style={{ height: 18, fontSize: 10, color: 'var(--bad)', borderColor: 'var(--bad)' }}>
              Unavailable
            </span>
          )}
          {ep.runtime && (
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)', marginLeft: 'auto' }}>
              {formatDuration(ep.runtime)}
            </span>
          )}
        </div>
        {ep.overview && (
          <p
            style={{
              fontSize: 13,
              color: 'var(--ink-3)',
              lineHeight: 1.5,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical' as const,
              overflow: 'hidden',
              marginBottom: progress !== null ? 6 : 0,
            }}
          >
            {ep.overview}
          </p>
        )}
        {progress !== null && !ws?.completed && (
          <div className="bar" style={{ marginTop: 4 }}>
            <i style={{ width: `${Math.min(progress, 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  )
}

export function ShowDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [show, setShow] = useState<ShowDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeSeason, setActiveSeason] = useState<SeasonSummary | null>(null)
  const [episodes, setEpisodes] = useState<EpisodeListItem[]>([])
  const [episodesLoading, setEpisodesLoading] = useState(false)

  const [upNext, setUpNext] = useState<UpNextResponse | null>(null)
  const [showProgress, setShowProgress] = useState<ShowProgressData | null>(null)

  const [metadataRefreshing, setMetadataRefreshing] = useState(false)
  const [showMatchPanel, setShowMatchPanel] = useState(false)
  const [candidates, setCandidates] = useState<MetadataCandidate[] | null>(null)
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [matchingId, setMatchingId] = useState<string | null>(null)
  const [metadataStatus, setMetadataStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    getShow(id).then((res) => {
      if (res.ok) {
        setShow(res.data)
        setMetadataStatus(res.data.metadataStatus ?? null)
        if (res.data.seasons.length > 0) {
          setActiveSeason(res.data.seasons[0])
        }
      }
      setLoading(false)
    })
    getShowUpNext(id).then((res) => {
      if (res.ok) setUpNext(res.data)
    })
    getShowProgress(id).then((res) => {
      if (res.ok) setShowProgress(res.data)
    })
  }, [id])

  async function handleRefreshMetadata() {
    if (!id) return
    setMetadataRefreshing(true)
    const res = await refreshMetadata(id)
    setMetadataRefreshing(false)
    if (res.ok) {
      const showRes = await getShow(id)
      if (showRes.ok) {
        setShow(showRes.data)
        setMetadataStatus(showRes.data.metadataStatus ?? null)
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
      const showRes = await getShow(id)
      if (showRes.ok) {
        setShow(showRes.data)
        setMetadataStatus(showRes.data.metadataStatus ?? null)
      }
    }
  }

  useEffect(() => {
    if (!activeSeason) return
    setEpisodesLoading(true)
    getSeasonEpisodes(activeSeason.id).then((res) => {
      if (res.ok) setEpisodes(res.data)
      setEpisodesLoading(false)
    })
  }, [activeSeason])

  if (loading) {
    return <div style={{ color: 'var(--ink-3)' }}>Loading…</div>
  }

  if (!show) {
    return <div style={{ color: 'var(--bad)' }}>Show not found.</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, maxWidth: 900 }}>
      {/* Back button */}
      <button
        onClick={() => navigate(-1)}
        className="btn btn-ghost btn-sm"
        style={{ alignSelf: 'flex-start', marginBottom: 24 }}
      >
        ← Back
      </button>

      {/* Backdrop hero */}
      {show.backdropUrl && (
        <div
          style={{
            position: 'relative',
            height: 420,
            borderRadius: 'var(--r-4)',
            overflow: 'hidden',
            marginBottom: 0,
          }}
        >
          <img
            src={show.backdropUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 30%, var(--bg-0) 100%)' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, var(--bg-0) 0%, transparent 60%)' }} />
        </div>
      )}

      {/* Show header */}
      <div
        style={{
          display: 'flex',
          gap: 24,
          alignItems: 'flex-end',
          marginTop: show.backdropUrl ? -100 : 0,
          position: 'relative',
          zIndex: 2,
          padding: '0 0 28px',
        }}
      >
        {show.posterUrl && (
          <img
            src={show.posterUrl}
            alt={show.title}
            style={{
              width: 200,
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
          <span className="chip chip-mono" style={{ marginBottom: 10, display: 'inline-flex' }}>
            TV Show
          </span>
          <h1 className="display" style={{ fontSize: 64, lineHeight: 1, letterSpacing: '-0.02em', marginBottom: 12, color: 'var(--ink-1)' }}>
            {show.title}
          </h1>
          <div className="row gap-3" style={{ marginBottom: 12, fontSize: 13, color: 'var(--ink-2)', flexWrap: 'wrap' }}>
            {show.year && <span className="mono">{show.year}</span>}
            {show.year && show.contentRating && <span className="dot-sep">·</span>}
            {show.contentRating && <span>{show.contentRating}</span>}
            {(show.year || show.contentRating) && <span className="dot-sep">·</span>}
            <span>{show.seasons.length} {show.seasons.length === 1 ? 'season' : 'seasons'}</span>
          </div>
          {show.overview && (
            <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: 560 }}>
              {show.overview}
            </p>
          )}

          {/* Integration links */}
          {show.integrationLinks && show.integrationLinks.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {show.integrationLinks.map((link, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '3px 9px',
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
                    <span style={{ color: 'var(--ok)', fontWeight: 500 }}>· Monitored</span>
                  )}
                  {link.qualityProfile && (
                    <span>· {link.qualityProfile}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Continue / Start Watching */}
          {upNext && (
            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              {upNext.episode ? (
                <button
                  onClick={() => navigate(`/media/${(upNext as { episode: PlayableEpisode }).episode.id}`)}
                  className="btn btn-primary"
                >
                  {`Continue — S${String((upNext as { episode: PlayableEpisode }).episode.seasonNumber).padStart(2, '0')}E${String((upNext as { episode: PlayableEpisode }).episode.episodeNumber).padStart(2, '0')} · ${(upNext as { episode: PlayableEpisode }).episode.title}`}
                </button>
              ) : (upNext as { allCompleted: boolean }).allCompleted ? (
                <button
                  onClick={() => {
                    const restartId = (upNext as { allCompleted: true; restartEpisodeId?: string }).restartEpisodeId
                    if (restartId) navigate(`/media/${restartId}`)
                  }}
                  className="btn"
                >
                  Watch Again
                </button>
              ) : (
                <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                  No playable episodes yet
                </span>
              )}

              {showProgress && showProgress.totalEpisodes > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                    {showProgress.allCompleted
                      ? `All ${showProgress.totalEpisodes} episodes watched`
                      : `${showProgress.completedEpisodes} of ${showProgress.totalEpisodes} episodes watched`}
                  </span>
                  <div className="bar" style={{ width: 100 }}>
                    <i
                      style={{
                        width: `${showProgress.percentComplete}%`,
                        background: showProgress.allCompleted ? 'var(--ok)' : 'var(--accent)',
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Needs-review banner */}
      {metadataStatus === 'needs_review' && (
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
            Find show match
          </button>
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
        {metadataStatus !== 'needs_review' && (
          <button onClick={handleOpenMatchPanel} className="btn btn-sm">
            Find show match
          </button>
        )}
      </div>

      {/* Match panel */}
      {showMatchPanel && (
        <div className="surface" style={{ padding: '20px', marginBottom: 24 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-1)' }}>Find a show match</h3>
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

      {/* Season tabs + episode list */}
      {show.seasons.length > 0 && (
        <div>
          {/* Season tabs */}
          <div
            style={{
              display: 'flex',
              gap: 0,
              marginBottom: 16,
              borderBottom: '1px solid var(--line-1)',
              flexWrap: 'wrap',
            }}
          >
            {show.seasons.map((season) => {
              const isActive = activeSeason?.id === season.id
              return (
                <button
                  key={season.id}
                  onClick={() => setActiveSeason(season)}
                  style={{
                    padding: '10px 16px',
                    fontSize: 14,
                    fontWeight: isActive ? 500 : 400,
                    background: 'transparent',
                    border: 'none',
                    borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                    color: isActive ? 'var(--ink-1)' : 'var(--ink-3)',
                    cursor: 'pointer',
                    transition: 'color var(--d-fast) var(--ease), border-color var(--d-fast) var(--ease)',
                    marginBottom: -1,
                  }}
                >
                  Season {season.seasonNumber}
                  <span
                    className="mono"
                    style={{
                      marginLeft: 6,
                      fontSize: 11,
                      color: isActive ? 'var(--ink-3)' : 'var(--ink-4)',
                    }}
                  >
                    {season.episodeCount}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Active season overview */}
          {activeSeason?.overview && (
            <p
              style={{
                fontSize: 13,
                color: 'var(--ink-3)',
                lineHeight: 1.6,
                marginBottom: 12,
                maxWidth: 640,
              }}
            >
              {activeSeason.overview}
            </p>
          )}

          {/* Episode list */}
          {episodesLoading ? (
            <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>Loading episodes…</div>
          ) : (
            <div>
              {episodes.map((ep) => (
                <EpisodeRow
                  key={ep.id}
                  ep={ep}
                  onClick={() => navigate(`/media/${ep.id}`)}
                  unavailable={!ep.hasPlayableFile}
                />
              ))}
              {episodes.length === 0 && (
                <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                  No episodes found for this season.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
