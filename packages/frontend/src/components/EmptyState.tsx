import { useNavigate } from 'react-router-dom'

interface EmptyStateProps {
  title: string
  description: string
  ctaLabel?: string
  ctaHref?: string
}

export function EmptyState({ title, description, ctaLabel, ctaHref }: EmptyStateProps) {
  const navigate = useNavigate()

  return (
    <div
      className="surface"
      style={{
        padding: 36,
        minHeight: 280,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 16,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 'var(--r-3)',
          background: 'var(--bg-3)',
          border: '1px solid var(--line-1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 20,
          color: 'var(--ink-4)',
          marginBottom: 4,
        }}
      >
        ◻
      </div>
      <h2 className="display" style={{ fontSize: 32, lineHeight: 1.1, color: 'var(--ink-1)' }}>{title}</h2>
      <p style={{ fontSize: 14, color: 'var(--ink-2)', maxWidth: 360, lineHeight: 1.6 }}>{description}</p>
      {ctaLabel && ctaHref && (
        <button
          onClick={() => navigate(ctaHref)}
          className="btn btn-primary"
          style={{ marginTop: 8 }}
        >
          {ctaLabel}
        </button>
      )}
    </div>
  )
}
