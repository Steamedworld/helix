import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { getShow, getSeasonEpisodes } from '../api/tv'
import { searchMetadata, matchMetadata, refreshMetadata } from '../api/metadata'
import type { ShowDetail as ShowDetailType, SeasonSummary, EpisodeListItem } from '../api/tv'
import type { MetadataCandidate } from '../api/metadata'

const DEFAULT_USER_ID = 'default'

function formatDuration(seconds: number | null): string {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  return `${m}m`
}

function EpisodeRow({ ep, onClick }: { ep: EpisodeListItem; onClick: () => void }) {
  const ws = ep.watchState
  const progress =
    ws && ws.duration_seconds && ws.duration_seconds > 0
      ? (ws.position_seconds / ws.duration_seconds) * 100
      : null

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        gap: 14,
        padding: '14px 16px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
        alignItems: 'flex-start',
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'
      }}
    >
      {/* Ep number badge */}
      <div
        style={{
          flexShrink: 0,
          width: 36,
          height: 36,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-muted)',
          marginTop: 2,
        }}
      >
        {ep.episodeNumber}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>
            {ep.episodeTitle ?? ep.title}
          </span>
          {ws?.completed && (
            <span
              style={{
                fontSize: 10,
                padding: '1px 6px',
                background: 'rgba(76,175,125,0.15)',
                border: '1px solid var(--success)',
                borderRadius: 3,
                color: 'var(--success)',
                fontWeight: 500,
              }}
            >
              Watched
            </span>
          )}
          {ep.runtime && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              {formatDuration(ep.runtime)}
            </span>
          )}
        </div>
        {ep.overview && (
          <p
            style={{
              fontSize: 12,
              color: 'var(--text-muted)',
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
          <div
            style={{
              height: 3,
              background: 'var(--bg-elevated)',
              borderRadius: 2,
              overflow: 'hidden',
              marginTop: 4,
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

  // Metadata state
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
    getSeasonEpisodes(activeSeason.id, DEFAULT_USER_ID).then((res) => {
      if (res.ok) setEpisodes(res.data)
      setEpisodesLoading(false)
    })
  }, [activeSeason])

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  if (!show) {
    return <div style={{ color: 'var(--danger)' }}>Show not found.</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 900 }}>
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

      {/* Backdrop hero */}
      {show.backdropUrl && (
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
            src={show.backdropUrl}
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

      {/* Show header */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {show.posterUrl && (
          <img
            src={show.posterUrl}
            alt={show.title}
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
            <h1 style={{ fontSize: 28, fontWeight: 700 }}>{show.title}</h1>
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
              TV Show
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {show.year && (
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  color: 'var(--text-muted)',
                }}
              >
                {show.year}
              </span>
            )}
            {show.contentRating && (
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  color: 'var(--text-muted)',
                }}
              >
                {show.contentRating}
              </span>
            )}
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--text-muted)',
              }}
            >
              {show.seasons.length} {show.seasons.length === 1 ? 'season' : 'seasons'}
            </span>
          </div>
          {show.overview && (
            <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 600 }}>
              {show.overview}
            </p>
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
            Find show match
          </button>
        </div>
      )}

      {/* Metadata action row */}
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
        {metadataStatus !== 'needs_review' && (
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
            Find show match
          </button>
        )}
      </div>

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
            <h3 style={{ fontSize: 15, fontWeight: 600 }}>Find a show match</h3>
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
                      background: matchingId === c.externalId ? 'var(--bg-elevated)' : 'var(--accent)',
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

      {/* Season tabs + episode list */}
      {show.seasons.length > 0 && (
        <div>
          {/* Season tabs */}
          <div
            style={{
              display: 'flex',
              gap: 6,
              marginBottom: 16,
              borderBottom: '1px solid var(--border)',
              paddingBottom: 10,
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
                    padding: '5px 14px',
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 400,
                    background: isActive ? 'var(--accent)' : 'var(--bg-elevated)',
                    border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 4,
                    color: isActive ? '#fff' : 'var(--text-muted)',
                    cursor: 'pointer',
                    transition: 'background 0.15s, color 0.15s',
                  }}
                >
                  Season {season.seasonNumber}
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 11,
                      opacity: 0.7,
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
                color: 'var(--text-muted)',
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
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading episodes…</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {episodes.map((ep) => (
                <EpisodeRow
                  key={ep.id}
                  ep={ep}
                  onClick={() => navigate(`/media/${ep.id}`)}
                />
              ))}
              {episodes.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
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
