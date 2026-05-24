import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MediaItem } from '@helix/shared'

interface MediaCardProps {
  item: MediaItem
  compact?: boolean
}

function kindIcon(kind: MediaItem['kind']): string {
  switch (kind) {
    case 'movie': return '▶'
    case 'track': return '♪'
    case 'photo': return '◻'
    default: return '▶'
  }
}

export function MediaCard({ item, compact = false }: MediaCardProps) {
  const navigate = useNavigate()
  const [imgError, setImgError] = useState(false)
  const posterUrl = (item as MediaItem & { posterUrl?: string | null }).posterUrl ?? null
  const showImage = posterUrl && !imgError

  return (
    <div
      onClick={() => navigate(`/media/${item.id}`)}
      style={{
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
      }}
    >
      {/* Poster area */}
      <div
        style={{
          width: '100%',
          aspectRatio: compact ? '16/9' : '2/3',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: compact ? 24 : 36,
          position: 'relative',
          transition: 'border-color 0.15s',
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent)'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'
        }}
      >
        {showImage ? (
          <img
            src={posterUrl}
            alt={item.title}
            onError={() => setImgError(true)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ) : (
          <span>{kindIcon(item.kind)}</span>
        )}
      </div>

      {/* Info */}
      <div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.title}
        </div>
        {item.year && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{item.year}</div>
        )}
      </div>
    </div>
  )
}
