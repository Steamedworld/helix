import { NavLink, useNavigate } from 'react-router-dom'
import { NodeStatus } from './NodeStatus'
import { useAuth } from '../context/AuthContext'

interface NavItem {
  label: string
  href: string
  icon: string
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/', icon: '⊞' },
  { label: 'Libraries', href: '/libraries', icon: '⊟' },
  { label: 'Movies', href: '/libraries?kind=movies', icon: '▶' },
  { label: 'TV Shows', href: '/shows', icon: '▭' },
  { label: 'Settings', href: '/settings', icon: '⚙' },
]

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    navigate('/', { replace: true })
  }

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          onClick={onClose}
          style={{
            display: 'none',
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 9,
          }}
          className="mobile-overlay"
        />
      )}
      <aside
        style={{
          width: 'var(--sidebar-width)',
          background: 'var(--bg-surface)',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          height: '100%',
          position: 'sticky',
          top: 0,
        }}
      >
        {/* Logo */}
        <div
          style={{
            padding: '20px 16px 16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              background: 'var(--accent)',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: 14,
              color: 'white',
            }}
          >
            H
          </div>
          <span style={{ fontWeight: 600, fontSize: 16, letterSpacing: '-0.3px' }}>Helix</span>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '8px 0', overflowY: 'auto' }}>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.href}
              to={item.href}
              end={item.href === '/'}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 16px',
                color: isActive ? 'var(--text)' : 'var(--text-muted)',
                background: isActive ? 'var(--bg-elevated)' : 'transparent',
                borderRadius: 6,
                margin: '1px 8px',
                fontSize: 14,
                fontWeight: isActive ? 500 : 400,
                transition: 'background 0.15s, color 0.15s',
                textDecoration: 'none',
              })}
            >
              <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <NodeStatus />

        {/* User section */}
        {user && (
          <div
            style={{
              padding: '12px 16px',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--text-muted)',
                flexShrink: 0,
              }}
            >
              {user.display_name.charAt(0).toUpperCase()}
            </div>
            <span
              style={{
                fontSize: 13,
                color: 'var(--text)',
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user.display_name}
            </span>
            <button
              onClick={handleLogout}
              title="Sign out"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: 14,
                cursor: 'pointer',
                padding: '2px 4px',
                borderRadius: 3,
                flexShrink: 0,
                lineHeight: 1,
              }}
            >
              ⏻
            </button>
          </div>
        )}
      </aside>
    </>
  )
}
