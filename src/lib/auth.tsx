import * as React from 'react'
import * as api from './api'
import { ApiError } from './api'
import type { CurrentUser } from './loyalty'

interface AuthContextValue {
  /** Authenticated user, or null when signed out. */
  user: CurrentUser | null
  /** True while the stored session is being validated on launch. */
  bootstrapping: boolean
  /** Refreshes /api/me in place; returns the fresh user or null. */
  refresh: () => Promise<CurrentUser | null>
  signIn: (phone: string, pin: string) => Promise<CurrentUser>
  signUp: (name: string, phone: string, pin: string) => Promise<CurrentUser>
  signOut: () => Promise<void>
}

const AuthContext = React.createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<CurrentUser | null>(null)
  const [bootstrapping, setBootstrapping] = React.useState(true)

  const refresh = React.useCallback(async (): Promise<CurrentUser | null> => {
    try {
      const fresh = await api.fetchMe()
      setUser(fresh)
      return fresh
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setUser(null)
      return null
    }
  }, [])

  // On launch: if a session cookie was persisted, validate it against /api/me.
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        if (!(await api.hasStoredSession())) return
        const fresh = await api.fetchMe()
        if (!cancelled) setUser(fresh)
      } catch {
        // Stale or invalid session - treat as signed out.
      } finally {
        if (!cancelled) setBootstrapping(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Bootstrapping also finishes fast when there is no stored session.
  React.useEffect(() => {
    void api.hasStoredSession().then((hasSession) => {
      if (!hasSession) setBootstrapping(false)
    })
  }, [])

  const signIn = React.useCallback(async (phone: string, pin: string) => {
    const authenticated = await api.login(phone, pin)
    setUser(authenticated)
    return authenticated
  }, [])

  const signUp = React.useCallback(async (name: string, phone: string, pin: string) => {
    const created = await api.register(name, phone, pin)
    setUser(created)
    return created
  }, [])

  const signOut = React.useCallback(async () => {
    await api.logout()
    setUser(null)
  }, [])

  const value = React.useMemo(
    () => ({ user, bootstrapping, refresh, signIn, signUp, signOut }),
    [user, bootstrapping, refresh, signIn, signUp, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within an AuthProvider')
  return context
}