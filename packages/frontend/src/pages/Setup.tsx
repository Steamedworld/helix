import { useState } from 'react'
import { setupAdmin } from '../api/auth'
import { useAuth } from '../context/AuthContext'
import { HelixMark } from '../components/HelixMark'

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
          maxWidth: 420,
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

        <h1 className="display" style={{ fontSize: 32, lineHeight: 1.1, marginBottom: 8, color: 'var(--ink-1)' }}>
          Claim your server
        </h1>
        <p style={{ fontSize: 14, color: 'var(--ink-3)', lineHeight: 1.6, marginBottom: 24 }}>
          Create your admin account. This first account becomes the server owner.
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
              placeholder="admin"
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
              autoComplete="new-password"
              placeholder="At least 8 characters"
            />
          </div>

          <div>
            <label className="field-label">Confirm password</label>
            <input
              className="input"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
              placeholder="Repeat your password"
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
            {submitting ? 'Creating account…' : 'Create admin account'}
          </button>
        </form>
      </div>
    </div>
  )
}
