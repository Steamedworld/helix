import type React from 'react'

interface IconProps {
  size?: number
  className?: string
  style?: React.CSSProperties
}

const iconProps = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
})

export function IconHome({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H5a1 1 0 01-1-1V9.5z" />
      <path d="M9 21V12h6v9" />
    </svg>
  )
}

export function IconFilm({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M2 9h5M17 9h5M2 15h5M17 15h5" />
    </svg>
  )
}

export function IconTv({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <rect x="2" y="4" width="20" height="14" rx="2" />
      <path d="M8 20h8M12 18v2" />
    </svg>
  )
}

export function IconPlay({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <polygon points="5,3 19,12 5,21" />
    </svg>
  )
}

export function IconPause({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  )
}

export function IconPlus({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function IconSearch({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5L21 21" />
    </svg>
  )
}

export function IconSettings({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  )
}

export function IconLogout({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  )
}

export function IconList({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  )
}

export function IconFolder({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  )
}

export function IconShuffle({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
    </svg>
  )
}

export function IconChevronRight({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M9 18l6-6-6-6" />
    </svg>
  )
}

export function IconChevronDown({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export function IconDots({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </svg>
  )
}

export function IconKey({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M21 2l-9.6 9.6M15.5 7.5l3 3M19 6l2 2" />
    </svg>
  )
}

export function IconShield({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M12 2L3 7v6c0 5.1 3.9 9.9 9 11 5.1-1.1 9-5.9 9-11V7l-9-5z" />
    </svg>
  )
}

export function IconGlobe({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
    </svg>
  )
}

export function IconDatabase({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v4c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 9v4c0 1.66 4.03 3 9 3s9-1.34 9-3V9" />
      <path d="M3 13v4c0 1.66 4.03 3 9 3s9-1.34 9-3v-4" />
    </svg>
  )
}

export function IconHeart({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
    </svg>
  )
}

export function IconDownload({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  )
}

export function IconVolume({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
      <path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" />
    </svg>
  )
}

export function IconSubtitles({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M7 15h4M15 15h2M7 11h2M13 11h4" />
    </svg>
  )
}

export function IconCast({ size = 16, className, style }: IconProps) {
  return (
    <svg {...iconProps(size)} className={className} style={style}>
      <path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6" />
      <line x1="2" y1="20" x2="2.01" y2="20" />
    </svg>
  )
}
