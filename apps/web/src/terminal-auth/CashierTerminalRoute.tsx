import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { currentAccess } from './cache'

export function CashierTerminalRoute({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState<boolean>()
  const location = useLocation()
  useEffect(() => { void currentAccess().then(state => setAllowed(Boolean(state?.cache && state.employee && state.policy.valid))).catch(() => setAllowed(false)) }, [])
  if (allowed === undefined) return <main className="route-pending" role="status">Checking terminal access…</main>
  return allowed ? <>{children}</> : <Navigate to="/pos/login" replace state={{ from: location.pathname }} />
}
