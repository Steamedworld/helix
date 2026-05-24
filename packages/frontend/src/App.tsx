import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { Dashboard } from './pages/Dashboard'
import { Libraries } from './pages/Libraries'
import { AddLibrary } from './pages/AddLibrary'
import { LibraryDetail } from './pages/LibraryDetail'
import { MediaDetail } from './pages/MediaDetail'

function Settings() {
  return (
    <div style={{ padding: '24px 0' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>Settings</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Coming soon.</p>
    </div>
  )
}

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
      { path: 'settings', element: <Settings /> },
    ],
  },
])

export function App() {
  return <RouterProvider router={router} />
}
