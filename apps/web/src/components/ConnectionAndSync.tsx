import { useCallback, useEffect, useState } from 'react'
import { configuredApiUrl } from '../lib/catalog'
import { posDb } from '../lib/db'
import { pushPendingOrders } from '../lib/order-sync'
import { usePosStore } from '../lib/pos-store'

export function ConnectionAndSync() {
  const catalogStatus = usePosStore(state => state.catalogStatus)
  const [apiReachable, setApiReachable] = useState<boolean | null>(null)
  const [offline, setOffline] = useState(!navigator.onLine)
  const [unresolved, setUnresolved] = useState<number | null>(null)
  const [eligible, setEligible] = useState(0)
  const [busy, setBusy] = useState(false)

  const update = useCallback(async () => {
    setOffline(!navigator.onLine)
    try {
      const entries = await posDb.outbox.where('status').anyOf('pending', 'failed').toArray()
      setUnresolved(entries.length)
      setEligible(entries.filter(entry => entry.status === 'pending' || entry.failure_kind === 'connectivity').length)
    } catch { setUnresolved(null); setEligible(0) }
    if (!navigator.onLine) { setApiReachable(false); return }
    try {
      const response = await fetch(`${configuredApiUrl()}/health`, { signal: AbortSignal.timeout(3_000) })
      setApiReachable(response.ok)
    } catch { setApiReachable(false) }
  }, [])

  useEffect(() => {
    void update()
    const timer = window.setInterval(() => void update(), 15_000)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => { window.clearInterval(timer); window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [update])

  const sync = async () => {
    setBusy(true)
    try { await pushPendingOrders() } catch { /* The queue retains retryable failures. */ }
    finally { setBusy(false); await update() }
  }
  const label = offline ? 'Browser offline' : apiReachable === null ? 'Checking API…' :
    !apiReachable ? 'API unreachable' : catalogStatus === 'unavailable' ? 'Catalog unavailable' : 'API reachable'
  const detail = unresolved === null ? label : `${label}${unresolved ? ` · ${unresolved} unresolved` : ''}`
  return <><div className={`connection ${offline || apiReachable === false || catalogStatus === 'unavailable' ? 'connection-error' : ''}`}
    role="status" title={detail}>{detail}</div>
    <button className="sync" type="button" aria-label={busy ? 'Syncing orders' : `Sync pending orders${eligible ? `, ${eligible} eligible` : ''}`}
      title={eligible ? `Sync ${eligible} eligible order${eligible === 1 ? '' : 's'}` : 'No orders ready to sync'}
      onClick={() => void sync()} disabled={busy || !apiReachable || eligible === 0}>↻</button></>
}
