import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'

export function AppShell() {
  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        overflow: 'hidden',
        background: 'var(--bg-0)',
        position: 'relative',
      }}
    >
      {/* Subtle grain overlay placeholder */}
      {/* <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0, opacity: 0.03 }} /> */}

      <Sidebar />

      <main
        style={{
          flex: 1,
          overflowY: 'auto',
          minWidth: 0,
          position: 'relative',
          zIndex: 1,
        }}
      >
        <div style={{ padding: '32px 32px 64px', maxWidth: 1340, margin: '0 auto' }}>
          <Outlet />
        </div>
      </main>
    </div>
  )
}
