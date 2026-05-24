import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        overflow: 'hidden',
      }}
    >
      {/* Mobile hamburger */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        style={{
          display: 'none',
          position: 'fixed',
          top: 12,
          left: 12,
          zIndex: 20,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--text)',
          padding: '6px 10px',
          fontSize: 18,
        }}
        className="hamburger"
        aria-label="Toggle sidebar"
      >
        ☰
      </button>

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <main
        style={{
          flex: 1,
          overflowY: 'auto',
          background: 'var(--bg)',
          minWidth: 0,
        }}
      >
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 24px' }}>
          <Outlet />
        </div>
      </main>
    </div>
  )
}
