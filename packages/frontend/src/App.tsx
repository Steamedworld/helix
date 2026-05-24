import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { Dashboard } from './pages/Dashboard'
import { Libraries } from './pages/Libraries'
import { AddLibrary } from './pages/AddLibrary'
import { LibraryDetail } from './pages/LibraryDetail'
import { MediaDetail } from './pages/MediaDetail'
import { Shows } from './pages/Shows'
import { ShowDetail } from './pages/ShowDetail'
import { Settings } from './pages/Settings'
import { Setup } from './pages/Setup'
import { Login } from './pages/Login'
import { AuthProvider, useAuth } from './context/AuthContext'

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'libraries', element: <Libraries /> },
      { path: 'libraries/new', element: <AddLibrary /> },
      { path: 'libraries/:id', element: <LibraryDetail /> },
      { path: 'media/:id', element: <MediaDetail /> },
      { path: 'shows', element: <Shows /> },
      { path: 'shows/:id', element: <ShowDetail /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
])

function AuthGate() {
  const { user, loading, setupRequired } = useAuth()

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg)',
          color: 'var(--text-muted)',
          fontSize: 14,
        }}
      >
        Loading…
      </div>
    )
  }

  if (setupRequired) {
    return <Setup />
  }

  if (!user) {
    return <Login />
  }

  return <RouterProvider router={router} />
}

export function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  )
}
