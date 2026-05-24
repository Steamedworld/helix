import { useNavigate } from 'react-router-dom'
import type { MediaItem } from '@helix/shared'

interface MediaCardProps {
  item: MediaItem
  compact?: boolean
}

export function MediaCard({ item, compact = false }: MediaCardProps) {
  const navigate = useNavigate()

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
      {/* Poster placeholder */}
      <div
        style={{
          width: '100%',
          aspectRatio: compact ? '16/9' : '2/3',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: compact ? 24 : 36,
          transition: 'border-color 0.15s',
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent)'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'
        }}
      >
        {item.kind === 'movie' ? '▶' : item.kind === 'track' ? '♪' : item.kind === 'photo' ? '◻' : '▶'}
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
