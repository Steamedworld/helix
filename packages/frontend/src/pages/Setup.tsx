import { useState } from 'react'
import { setupAdmin } from '../api/auth'
import { useAuth } from '../context/AuthContext'

export function Setup() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setSubmitting(true)
    const res = await setupAdmin(username, password)
    if (!res.ok) {
      setError(res.error ?? 'Setup failed')
      setSubmitting(false)
      return
    }

    // Auto-login after setup
    const loginResult = await login(username, password)
    if (!loginResult.ok) {
      setError(loginResult.error ?? 'Login after setup failed')
      setSubmitting(false)
    }
    // On success, AuthContext re-renders and the auth gate renders the app
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        padding: 24,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 380,
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 32,
              height: 32,
              background: 'var(--accent)',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: 16,
              color: 'white',
            }}
          >
            H
          </div>
          <span style={{ fontWeight: 700, fontSize: 20, letterSpacing: '-0.3px' }}>Helix</span>
        </div>

        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Welcome to Helix</h1>
          <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Create your admin account to get started. This is a one-time setup.
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)' }}>
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              autoComplete="username"
              placeholder="admin"
              style={{
                padding: '9px 12px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                color: 'var(--text)',
                fontSize: 14,
                outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)' }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              placeholder="At least 8 characters"
              style={{
                padding: '9px 12px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                color: 'var(--text)',
                fontSize: 14,
                outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)' }}>
              Confirm password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
              placeholder="Repeat your password"
              style={{
                padding: '9px 12px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                color: 'var(--text)',
                fontSize: 14,
                outline: 'none',
              }}
            />
          </div>

          {error && (
            <div
              style={{
                padding: '8px 12px',
                background: 'rgba(255,95,95,0.08)',
                border: '1px solid var(--danger)',
                borderRadius: 'var(--radius)',
                fontSize: 13,
                color: 'var(--danger)',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: '10px 20px',
              background: submitting ? 'var(--bg-elevated)' : 'var(--accent)',
              border: 'none',
              borderRadius: 'var(--radius)',
              color: submitting ? 'var(--text-muted)' : '#fff',
              fontSize: 14,
              fontWeight: 600,
              cursor: submitting ? 'default' : 'pointer',
              opacity: submitting ? 0.7 : 1,
              marginTop: 4,
            }}
          >
            {submitting ? 'Creating account…' : 'Create admin account'}
          </button>
        </form>
      </div>
    </div>
  )
}
