import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createLibrary } from '../api/libraries'
import type { LibraryKind } from '@helix/shared'

const KIND_OPTIONS: { value: LibraryKind; label: string }[] = [
  { value: 'movies', label: 'Movies' },
  { value: 'tv', label: 'TV Shows' },
  { value: 'music', label: 'Music' },
  { value: 'photos', label: 'Photos' },
  { value: 'other', label: 'Other' },
]

export function AddLibrary() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<LibraryKind>('movies')
  const [rootPath, setRootPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !rootPath.trim()) {
      setError('All fields are required.')
      return
    }
    setSaving(true)
    setError(null)
    const res = await createLibrary({ name: name.trim(), kind, root_path: rootPath.trim() })
    setSaving(false)
    if (res.ok) {
      navigate(`/libraries/${res.data.id}`)
    } else {
      setError(res.error)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text)',
    fontSize: 14,
    outline: 'none',
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-muted)',
    marginBottom: 6,
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <button
        onClick={() => navigate('/libraries')}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--text-muted)',
          fontSize: 13,
          cursor: 'pointer',
          marginBottom: 20,
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        ← Back to Libraries
      </button>

      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Add Library</h1>

      {error && (
        <div
          style={{
            padding: '10px 14px',
            background: 'rgba(255,95,95,0.1)',
            border: '1px solid var(--danger)',
            borderRadius: 'var(--radius)',
            color: 'var(--danger)',
            fontSize: 13,
            marginBottom: 20,
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <label style={labelStyle} htmlFor="name">
            Name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Movies"
            style={inputStyle}
            required
          />
        </div>

        <div>
          <label style={labelStyle} htmlFor="kind">
            Type
          </label>
          <select
            id="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as LibraryKind)}
            style={inputStyle}
          >
            {KIND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={labelStyle} htmlFor="root_path">
            Root Path
          </label>
          <input
            id="root_path"
            type="text"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            placeholder="/media/movies"
            style={inputStyle}
            required
          />
          <p style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            Absolute path on the server where your media files are stored.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
          <button
            type="submit"
            disabled={saving}
            style={{
              flex: 1,
              padding: '10px',
              background: 'var(--accent)',
              color: 'white',
              border: 'none',
              borderRadius: 'var(--radius)',
              fontSize: 14,
              fontWeight: 500,
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Adding…' : 'Add Library'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/libraries')}
            style={{
              padding: '10px 20px',
              background: 'var(--bg-elevated)',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontSize: 14,
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
