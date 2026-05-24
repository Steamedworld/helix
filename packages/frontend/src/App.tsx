import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { Dashboard } from './pages/Dashboard'
import { Libraries } from './pages/Libraries'
import { AddLibrary } from './pages/AddLibrary'
import { LibraryDetail } from './pages/LibraryDetail'
import { MediaDetail } from './pages/MediaDetail'
import { Settings } from './pages/Settings'

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
