import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getLibrary, triggerScan, getScanStatus } from '../api/libraries'
import { listLibraryPermissions, setLibraryPermission, revokeLibraryPermission, listUsers } from '../api/permissions'
import type { LibraryPermission, UserRecord } from '../api/permissions'
import { listMedia } from '../api/media'
import { useAuth } from '../context/AuthContext'
import type { Library, MediaItem } from '@helix/shared'
import { PosterGrid } from '../components/PosterGrid'
import { EmptyState } from '../components/EmptyState'

const KIND_LABELS: Record<string, string> = {
  movies: 'Movies',
  tv: 'TV',
  music: 'Music',
  photos: 'Photos',
  other: 'Other',
}

export function LibraryDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user: currentUser } = useAuth()
  const isAdmin = currentUser?.role === 'admin'

  const [library, setLibrary] = useState<Library | null>(null)
  const [items, setItems] = useState<MediaItem[]>([])
  const [itemCount, setItemCount] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Permission management state (admin only)
  const [permissions, setPermissions] = useState<LibraryPermission[]>([])
  const [allUsers, setAllUsers] = useState<UserRecord[]>([])
  const [grantUserId, setGrantUserId] = useState('')
  const [grantCanView, setGrantCanView] = useState(true)
  const [grantCanPlay, setGrantCanPlay] = useState(true)
  const [permSaving, setPermSaving] = useState(false)
  const [permError, setPermError] = useState<string | null>(null)

  function stopPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  async function loadData() {
    if (!id) return
    const [libRes, mediaRes] = await Promise.all([
      getLibrary(id),
      listMedia({ library_id: id, limit: 100 }),
    ])
    if (libRes.ok) {
      setLibrary(libRes.data)
      setScanning(libRes.data.scan_status === 'scanning')
    } else {
      setError(libRes.error)
    }
    if (mediaRes.ok) {
      setItems(mediaRes.data)
      setItemCount(mediaRes.data.length)
    }
    setLoading(false)
  }

  async function loadPermissions() {
    if (!id || !isAdmin) return
    const [permsRes, usersRes] = await Promise.all([
      listLibraryPermissions(id),
      listUsers(),
    ])
    if (permsRes.ok) setPermissions(permsRes.data)
    if (usersRes.ok) setAllUsers(usersRes.data)
  }

  useEffect(() => {
    loadData()
    loadPermissions()
    return () => stopPoll()
  }, [id])

  async function handleScan() {
    if (!id) return
    setScanning(true)
    await triggerScan(id)

    // Poll scan status
    pollRef.current = setInterval(async () => {
      const statusRes = await getScanStatus(id)
      if (statusRes.ok) {
        const { scan_status, item_count } = statusRes.data
        setItemCount(item_count)
        if (scan_status !== 'scanning') {
          setScanning(false)
          stopPoll()
          loadData()
        }
      }
    }, 1500)
  }

  async function handleGrantPermission() {
    if (!id || !grantUserId) return
    setPermSaving(true)
    setPermError(null)
    const res = await setLibraryPermission(id, grantUserId, { can_view: grantCanView, can_play: grantCanPlay })
    if (res.ok) {
      setGrantUserId('')
      setGrantCanView(true)
      setGrantCanPlay(true)
      await loadPermissions()
    } else {
      setPermError(res.error ?? 'Failed to grant permission')
    }
    setPermSaving(false)
  }

  async function handleUpdatePermission(userId: string, can_view: boolean, can_play: boolean) {
    if (!id) return
    await setLibraryPermission(id, userId, { can_view, can_play })
    await loadPermissions()
  }

  async function handleRevokePermission(userId: string) {
    if (!id) return
    await revokeLibraryPermission(id, userId)
    await loadPermissions()
  }

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  if (error || !library) {
    return (
      <div style={{ color: 'var(--danger)' }}>
        {error ?? 'Library not found.'}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header */}
      <div>
        <button
          onClick={() => navigate('/libraries')}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            fontSize: 13,
            cursor: 'pointer',
            padding: 0,
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          ← Libraries
        </button>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <h1 style={{ fontSize: 24, fontWeight: 600 }}>{library.name}</h1>
              <span
                style={{
                  fontSize: 11,
                  padding: '3px 8px',
                  background: 'var(--bg-elevated)',
                  borderRadius: 4,
                  color: 'var(--text-muted)',
                  fontWeight: 500,
                }}
              >
                {KIND_LABELS[library.kind] ?? library.kind}
              </span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {library.root_path} · {itemCount} {itemCount === 1 ? 'item' : 'items'}
            </p>
          </div>
          <button
            onClick={handleScan}
            disabled={scanning}
            style={{
              padding: '8px 16px',
              background: scanning ? 'var(--bg-elevated)' : 'var(--accent)',
              color: scanning ? 'var(--text-muted)' : 'white',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontSize: 13,
              fontWeight: 500,
              cursor: scanning ? 'default' : 'pointer',
            }}
          >
            {scanning ? 'Scanning…' : 'Scan Library'}
          </button>
        </div>
      </div>

      {/* Media grid */}
      {items.length === 0 ? (
        <EmptyState
          title="No items yet"
          description="Scan this library to discover media files, or add media files to the library path and scan."
          ctaLabel="Scan Now"
          ctaHref=""
        />
      ) : (
        <PosterGrid items={items} />
      )}

      {/* Permission management — admin only */}
      {isAdmin && (
        <section style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Access Permissions</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
            Control which users can view and play content from this library.
            Admin users always have full access.
          </p>

          {/* Existing grants */}
          {permissions.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              No users have been granted access yet.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {permissions.map((perm) => (
                <div
                  key={perm.user_id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 14px',
                    background: 'var(--bg-elevated)',
                    borderRadius: 'var(--radius)',
                    border: '1px solid var(--border)',
                    fontSize: 13,
                  }}
                >
                  <span style={{ flex: 1, fontWeight: 500 }}>
                    {perm.display_name ?? perm.username}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>
                      @{perm.username}
                    </span>
                  </span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={perm.can_view}
                      onChange={(e) => handleUpdatePermission(perm.user_id, e.target.checked, perm.can_play)}
                    />
                    View
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={perm.can_play}
                      onChange={(e) => handleUpdatePermission(perm.user_id, perm.can_view, e.target.checked)}
                    />
                    Play
                  </label>
                  <button
                    onClick={() => handleRevokePermission(perm.user_id)}
                    style={{
                      padding: '4px 10px',
                      background: 'none',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      fontSize: 12,
                      color: 'var(--danger)',
                      cursor: 'pointer',
                    }}
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Grant new access */}
          {(() => {
            const grantableUsers = allUsers.filter(
              (u) => u.role !== 'admin' && !permissions.some((p) => p.user_id === u.id)
            )
            if (grantableUsers.length === 0) return null
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <select
                  value={grantUserId}
                  onChange={(e) => setGrantUserId(e.target.value)}
                  style={{
                    padding: '6px 10px',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    color: 'var(--text)',
                    fontSize: 13,
                    minWidth: 160,
                  }}
                >
                  <option value="">Select user…</option>
                  {grantableUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.display_name ?? u.username} (@{u.username})
                    </option>
                  ))}
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={grantCanView}
                    onChange={(e) => setGrantCanView(e.target.checked)}
                  />
                  View
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={grantCanPlay}
                    onChange={(e) => setGrantCanPlay(e.target.checked)}
                  />
                  Play
                </label>
                <button
                  onClick={handleGrantPermission}
                  disabled={!grantUserId || permSaving}
                  style={{
                    padding: '6px 14px',
                    background: grantUserId && !permSaving ? 'var(--accent)' : 'var(--bg-elevated)',
                    color: grantUserId && !permSaving ? 'white' : 'var(--text-muted)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: grantUserId && !permSaving ? 'pointer' : 'default',
                  }}
                >
                  Grant Access
                </button>
                {permError && (
                  <span style={{ fontSize: 12, color: 'var(--danger)' }}>{permError}</span>
                )}
              </div>
            )
          })()}
        </section>
      )}
    </div>
  )
}
