import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { getShow, getSeasonEpisodes } from '../api/tv'
import type { ShowDetail as ShowDetailType, SeasonSummary, EpisodeListItem } from '../api/tv'

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

  useEffect(() => {
    if (!id) return
    getShow(id).then((res) => {
      if (res.ok) {
        setShow(res.data)
        if (res.data.seasons.length > 0) {
          setActiveSeason(res.data.seasons[0])
        }
      }
      setLoading(false)
    })
  }, [id])

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
