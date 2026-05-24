import type React from 'react'

interface HelixMarkProps {
  size?: number
  glow?: boolean
  className?: string
  style?: React.CSSProperties
}

export function HelixMark({ size = 32, glow = false, className, style }: HelixMarkProps) {
  const glowStyle: React.CSSProperties = glow
    ? { filter: 'drop-shadow(0 0 6px currentColor)', opacity: 0.9 }
    : {}

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ ...glowStyle, ...style }}
      aria-hidden="true"
    >
      {/* Two curved strands */}
      <path
        d="M 6 6 C 10 6, 14 14, 16 16 C 18 18, 22 26, 26 26"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M 26 6 C 22 6, 18 14, 16 16 C 14 18, 10 26, 6 26"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
      {/* Intersection dots */}
      <circle cx="16" cy="16" r="2.2" fill="currentColor" />
      <circle cx="16" cy="16" r="1.0" fill="var(--bg-1)" />
    </svg>
  )
}
