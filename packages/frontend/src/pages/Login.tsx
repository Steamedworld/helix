import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { HelixMark } from '../components/HelixMark'

export function Login() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const result = await login(username, password)
    if (!result.ok) {
      setError('Invalid username or password')
      setSubmitting(false)
    }
    // On success, AuthContext re-renders and auth gate shows the app
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-0)',
        padding: 24,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Atmospheric glow blobs */}
      <div
        style={{
          position: 'absolute',
          width: 500,
          height: 500,
          background: 'var(--accent)',
          borderRadius: '50%',
          filter: 'blur(120px)',
          opacity: 0.06,
          top: -200,
          right: -100,
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 400,
          height: 400,
          background: 'var(--cool)',
          borderRadius: '50%',
          filter: 'blur(100px)',
          opacity: 0.04,
          bottom: -150,
          left: -80,
          pointerEvents: 'none',
        }}
      />

      <div
        className="surface-raised"
        style={{
          width: '100%',
          maxWidth: 400,
          padding: 36,
          boxShadow: 'var(--shadow-3)',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <HelixMark size={28} style={{ color: 'var(--accent)' }} />
          <span className="display" style={{ fontSize: 24, color: 'var(--ink-1)' }}>Helix</span>
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 6, color: 'var(--ink-1)' }}>Sign in</h1>
        <p style={{ fontSize: 14, color: 'var(--ink-3)', marginBottom: 24 }}>
          Enter your credentials to continue.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label className="field-label">Username</label>
            <input
              className="input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              autoComplete="username"
            />
          </div>
          <div>
            <label className="field-label">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          {error && (
            <div
              style={{
                padding: '10px 14px',
                background: 'oklch(0.70 0.13 25 / 0.08)',
                border: '1px solid oklch(0.70 0.13 25 / 0.40)',
                borderRadius: 'var(--r-2)',
                fontSize: 13,
                color: 'var(--bad)',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="btn btn-primary btn-lg"
            style={{ width: '100%', marginTop: 8, justifyContent: 'center', opacity: submitting ? 0.7 : 1 }}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
