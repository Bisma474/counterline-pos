/**
 * StoreSwitcher — sidebar dropdown for accounts with more than one active store membership.
 * Renders nothing for the common single-store case, per the task's own scoping ("for users with
 * more than one active store_memberships row"). Persists the choice through setActiveStoreId(),
 * which activeStoreId() then respects everywhere else in the app, and reloads so every screen's
 * local Dexie cache and in-memory state re-bootstraps cleanly for the newly selected store.
 */
import { useEffect, useState, type ChangeEvent } from 'react'
import { activeStoreId, listActiveStores, setActiveStoreId, type ActiveStoreOption } from '../lib/catalog'

export function StoreSwitcher() {
  const [stores, setStores] = useState<ActiveStoreOption[]>([])
  const [current, setCurrent] = useState('')
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([listActiveStores(), activeStoreId()])
      .then(([options, id]) => {
        if (!active) return
        setStores(options)
        setCurrent(id)
      })
      .catch(() => {
        // Silent: an offline session or a single-store account just won't show a switcher.
      })
    return () => {
      active = false
    }
  }, [])

  if (stores.length < 2) return null

  const handleChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value
    if (!next || next === current) return
    setSwitching(true)
    try {
      await setActiveStoreId(next)
      window.location.reload()
    } catch {
      setSwitching(false)
    }
  }

  return (
    <label className="store-switcher">
      <span className="store-switcher-label">Store</span>
      <select value={current} onChange={event => void handleChange(event)} disabled={switching} aria-label="Switch store">
        {stores.map(store => (
          <option key={store.store_id} value={store.store_id}>
            {store.store_name || 'Untitled store'}
          </option>
        ))}
      </select>
    </label>
  )
}
