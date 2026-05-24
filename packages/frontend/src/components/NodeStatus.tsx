import { useEffect, useState } from 'react'
import { apiFetch } from '../api/client'

interface HealthData {
  status: string
  version: string
  node: string
}

export function NodeStatus() {
  const [health, setHealth] = useState<HealthData | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    apiFetch<HealthData>('/api/v1/health').then((res) => {
      if (res.ok) {
        setHealth(res.data)
      } else {
        setError(true)
      }
    })
  }, [])

  return (
    <div
      style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: error ? 'var(--danger)' : 'var(--success)',
          flexShrink: 0,
        }}
      />
      <div style={{ overflow: 'hidden' }}>
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
          {health?.node ?? 'Connecting…'}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {health ? `v${health.version}` : error ? 'Offline' : ''}
        </div>
      </div>
    </div>
  )
}
