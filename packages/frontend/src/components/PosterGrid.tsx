import type { MediaItem } from '@helix/shared'
import { MediaCard } from './MediaCard'

interface PosterGridProps {
  items: MediaItem[]
  minColumnWidth?: number
}

export function PosterGrid({ items }: PosterGridProps) {
  const colsClass =
    items.length <= 4 ? 'cols-4' : items.length <= 5 ? 'cols-5' : 'cols-6'

  return (
    <div className={`poster-grid ${colsClass}`}>
      {items.map((item) => (
        <MediaCard key={item.id} item={item} variant="poster" />
      ))}
    </div>
  )
}
