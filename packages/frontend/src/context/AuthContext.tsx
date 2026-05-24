import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { getAuthStatus, login as apiLogin, logout as apiLogout } from '../api/auth'
import type { AuthUser } from '../api/auth'

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  setupRequired: boolean
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [setupRequired, setSetupRequired] = useState(false)

  useEffect(() => {
    getAuthStatus().then((res) => {
      if (res.ok) {
        setSetupRequired(res.data.setupRequired)
        setUser(res.data.user ?? null)
      }
      setLoading(false)
    })
  }, [])

  async function login(username: string, password: string) {
    const res = await apiLogin(username, password)
    if (res.ok) {
      setUser(res.data.user)
      return { ok: true }
    }
    return { ok: false, error: res.error ?? 'Login failed' }
  }

  async function logout() {
    await apiLogout()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, setupRequired, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
