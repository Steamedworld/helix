import { NavLink, useNavigate } from 'react-router-dom'
import { NodeStatus } from './NodeStatus'
import { HelixMark } from './HelixMark'
import { useAuth } from '../context/AuthContext'
import {
  IconHome,
  IconFilm,
  IconTv,
  IconList,
  IconSettings,
  IconKey,
  IconLogout,
} from './Icons'
import type React from 'react'

interface NavItemDef {
  label: string
  href: string
  icon: React.ComponentType<{ size?: number }>
}

const NAV_ITEMS: NavItemDef[] = [
  { label: 'Dashboard', href: '/', icon: IconHome },
  { label: 'Movies', href: '/libraries?kind=movies', icon: IconFilm },
  { label: 'TV Shows', href: '/shows', icon: IconTv },
  { label: 'Libraries', href: '/libraries', icon: IconList },
  { label: 'Settings', href: '/settings', icon: IconSettings },
]

const ADMIN_NAV_ITEMS: NavItemDef[] = [
  { label: 'Integrations', href: '/integrations', icon: IconKey },
]

export function Sidebar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    navigate('/', { replace: true })
  }

  return (
    <aside
      style={{
        width: 'var(--sidebar-width)',
        background: 'var(--bg-1)',
        borderRight: '1px solid var(--line-1)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        flexShrink: 0,
        zIndex: 2,
        position: 'relative',
      }}
    >
      {/* Brand */}
      <div
        style={{
          padding: '20px 16px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <HelixMark size={28} style={{ color: 'var(--accent)' }} />
        <span
          className="display"
          style={{ fontSize: 22, lineHeight: 1, color: 'var(--ink-1)' }}
        >
          Helix
        </span>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '12px 0', overflowY: 'auto' }}>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.href}
              to={item.href}
              end={item.href === '/'}
              style={({ isActive }) => ({
                height: 36,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: isActive ? '0 12px 0 14px' : '0 12px 0 16px',
                margin: '2px 8px',
                borderRadius: 'var(--r-2)',
                fontSize: 14,
                fontWeight: isActive ? 500 : 400,
                color: isActive ? 'var(--ink-1)' : 'var(--ink-3)',
                background: isActive ? 'var(--bg-3)' : 'transparent',
                borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                transition: `background var(--d-fast) var(--ease), color var(--d-fast) var(--ease)`,
                textDecoration: 'none',
                cursor: 'pointer',
              })}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLAnchorElement
                if (!el.classList.contains('active')) {
                  el.style.background = 'var(--bg-2)'
                  el.style.color = 'var(--ink-1)'
                }
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLAnchorElement
                if (!el.classList.contains('active')) {
                  el.style.background = 'transparent'
                  el.style.color = 'var(--ink-3)'
                }
              }}
            >
              <Icon size={18} />
              {item.label}
            </NavLink>
          )
        })}

        {/* Admin section */}
        {user?.role === 'admin' && (
          <>
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: 'var(--ink-4)',
                padding: '12px 16px 4px',
                letterSpacing: '0.08em',
              }}
            >
              ADMIN
            </div>
            {ADMIN_NAV_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <NavLink
                  key={item.href}
                  to={item.href}
                  style={({ isActive }) => ({
                    height: 36,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: isActive ? '0 12px 0 14px' : '0 12px 0 16px',
                    margin: '2px 8px',
                    borderRadius: 'var(--r-2)',
                    fontSize: 14,
                    fontWeight: isActive ? 500 : 400,
                    color: isActive ? 'var(--ink-1)' : 'var(--ink-3)',
                    background: isActive ? 'var(--bg-3)' : 'transparent',
                    borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                    transition: `background var(--d-fast) var(--ease), color var(--d-fast) var(--ease)`,
                    textDecoration: 'none',
                    cursor: 'pointer',
                  })}
                  onMouseEnter={(e) => {
                    const el = e.currentTarget as HTMLAnchorElement
                    if (!el.classList.contains('active')) {
                      el.style.background = 'var(--bg-2)'
                      el.style.color = 'var(--ink-1)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    const el = e.currentTarget as HTMLAnchorElement
                    if (!el.classList.contains('active')) {
                      el.style.background = 'transparent'
                      el.style.color = 'var(--ink-3)'
                    }
                  }}
                >
                  <Icon size={18} />
                  {item.label}
                </NavLink>
              )
            })}
          </>
        )}
      </nav>

      {/* Server status — rendered in a surface pill */}
      <div
        style={{
          margin: '0 12px 8px',
          borderRadius: 'var(--r-3)',
          background: 'var(--bg-2)',
          border: '1px solid var(--line-1)',
          overflow: 'hidden',
        }}
      >
        <NodeStatus />
      </div>

      {/* User section */}
      {user && (
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--line-1)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div className="avatar">
            {user.display_name.charAt(0).toUpperCase()}
          </div>
          <span
            style={{
              fontSize: 13,
              color: 'var(--ink-2)',
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
            className="btn btn-icon btn-sm btn-ghost"
          >
            <IconLogout size={14} />
          </button>
        </div>
      )}
    </aside>
  )
}
