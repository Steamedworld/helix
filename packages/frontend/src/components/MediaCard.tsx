import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MediaItem } from '@helix/shared'
import type { MediaItemWithWatchState } from '../api/watchstate'

interface MediaCardProps {
  item: MediaItem
  compact?: boolean
  subtitle?: string
  variant?: 'poster' | 'wide'
}

export function MediaCard({ item, compact = false, subtitle, variant = 'poster' }: MediaCardProps) {
  const navigate = useNavigate()
  const [imgError, setImgError] = useState(false)
  const [hovered, setHovered] = useState(false)

  const posterUrl = (item as MediaItem & { posterUrl?: string | null }).posterUrl ?? null
  const backdropUrl = (item as MediaItem & { backdropUrl?: string | null }).backdropUrl ?? null

  // Watch state progress
  const ws = (item as MediaItemWithWatchState).watch_state ?? null
  const progress = ws && ws.duration_seconds && ws.duration_seconds > 0
    ? (ws.position_seconds / ws.duration_seconds) * 100
    : null

  // Effective variant: treat compact as wide
  const effectiveVariant = compact ? 'wide' : variant
  const isWide = effectiveVariant === 'wide'

  // Image to show
  const imageUrl = isWide ? (backdropUrl ?? posterUrl) : posterUrl
  const showImage = imageUrl && !imgError

  return (
    <div
      onClick={() => navigate(`/media/${item.id}`)}
      style={{
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        borderRadius: 'var(--r-3)',
        overflow: 'visible',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Image area */}
      <div
        style={{
          width: '100%',
          aspectRatio: isWide ? '16/9' : '2/3',
          borderRadius: 'var(--r-3)',
          overflow: 'hidden',
          position: 'relative',
          border: '1px solid var(--line-1)',
          background: 'linear-gradient(135deg, var(--bg-3), var(--bg-4))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ink-4)',
          transform: hovered ? 'translateY(-2px)' : 'translateY(0)',
          boxShadow: hovered ? 'var(--shadow-2)' : 'none',
          transition: `transform var(--d-fast) var(--ease), box-shadow var(--d-fast) var(--ease)`,
        }}
      >
        {showImage ? (
          <img
            src={imageUrl}
            alt={item.title}
            onError={() => setImgError(true)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ) : null}

        {/* Bottom gradient overlay */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(180deg, transparent 50%, var(--bg-2) 100%)',
            pointerEvents: 'none',
          }}
        />

        {/* Progress bar */}
        {progress !== null && !ws?.completed && (
          <div
            className="bar"
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: 3,
              borderRadius: 0,
            }}
          >
            <i style={{ width: `${Math.min(progress, 100)}%` }} />
          </div>
        )}
      </div>

      {/* Info below image */}
      <div style={{ paddingBottom: 4 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--ink-1)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.title}
        </div>
        {subtitle ? (
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--ink-3)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: 2,
            }}
          >
            {subtitle}
          </div>
        ) : (
          item.year && (
            <div
              className="mono"
              style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}
            >
              {item.year}
            </div>
          )
        )}
      </div>
    </div>
  )
}
