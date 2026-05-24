import type { MediaItem } from '@helix/shared'
import { MediaCard } from './MediaCard'

interface PosterGridProps {
  items: MediaItem[]
  minColumnWidth?: number
}

export function PosterGrid({ items, minColumnWidth = 160 }: PosterGridProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${minColumnWidth}px, 1fr))`,
        gap: 16,
      }}
    >
      {items.map((item) => (
        <MediaCard key={item.id} item={item} />
      ))}
    </div>
  )
}
