/**
 * StoreDetails — Owner/Manager settings screen at /settings/store.
 * Lets an owner or manager edit currency, timezone, address and country after the store
 * has already been created (Signup only collects currency/timezone up front). Reuses the
 * existing .invite-form card styling from SettingsOverview for visual consistency.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { accessToken, activeStoreId, configuredApiUrl } from '../lib/catalog'
import { posDb } from '../lib/db'
import { CURRENCY_OPTIONS, timezoneOptions } from '../lib/locale-options'

interface StoreRecord {
  id: string
  name: string
  timezone: string
  currency: string
  address: string | null
  country: string | null
}

export function StoreDetails() {
  const [storeId, setStoreId] = useState('')
  const [store, setStore] = useState<StoreRecord>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = async () => {
    setLoading(true)
    setLoadError('')
    try {
      const id = await activeStoreId()
      setStoreId(id)
      const token = await accessToken()
      const response = await fetch(`${configuredApiUrl()}/stores/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await response.json()) as StoreRecord & { message?: string }
      if (!response.ok) throw new Error(data.message ?? `Server error (${response.status})`)
      setStore(data)
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : 'Unable to load store details.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!store) return
    setError('')
    setMessage('')
    setSaving(true)
    try {
      const form = new FormData(event.currentTarget)
      const body = {
        currency: String(form.get('currency')).trim().toUpperCase(),
        timezone: String(form.get('timezone')).trim(),
        address: String(form.get('address')).trim() || null,
        country: String(form.get('country')).trim().toUpperCase() || null,
      }
      const token = await accessToken()
      const response = await fetch(`${configuredApiUrl()}/stores/${storeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const data = (await response.json()) as StoreRecord & { message?: string }
      if (!response.ok) throw new Error(data.message ?? `Server error (${response.status})`)
      setStore(data)
      // Currency and timezone feed every money/clock display cached locally (Register, receipts,
      // reports) via posDb.store_config — patch it directly rather than calling loadCatalog(),
      // which refuses to run at all while this store has any pending/unresolved outbox entry
      // (by design, to protect stock refresh) and would silently no-op here, leaving the local
      // cache stale even though the server save succeeded.
      const cachedConfig = await posDb.store_config.get(storeId)
      if (cachedConfig) {
        await posDb.store_config.put({ ...cachedConfig, currency: data.currency, timezone: data.timezone })
      }
      setMessage('Store details saved.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save store details.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-page">
      <div className="settings-heading">
        <span className="settings-icon" aria-hidden="true">
          ⚑
        </span>
        <div>
          <p className="kicker">STORE ADMINISTRATION</p>
          <h1>Store details</h1>
          <p>Business information used across receipts, reporting and the register.</p>
        </div>
      </div>
      <p>
        <Link to="/settings">← Back to settings</Link>
      </p>
      {loading ? (
        <p className="form-notice" role="status">
          Loading store details…
        </p>
      ) : loadError ? (
        <p className="form-notice error" role="alert">
          {loadError}
        </p>
      ) : store ? (
        <form className="invite-form" onSubmit={submit} style={{ maxWidth: 520 }}>
          <h3>{store.name}</h3>
          <label>
            Currency
            <select name="currency" defaultValue={store.currency}>
              {CURRENCY_OPTIONS.map(([code, label]) => (
                <option key={code} value={code}>
                  {code} — {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Timezone
            <select name="timezone" defaultValue={store.timezone}>
              {timezoneOptions().map(zone => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          <label>
            Address <small>(optional)</small>
            <input name="address" defaultValue={store.address ?? ''} maxLength={240} placeholder="123 Main St, Suite 4" />
          </label>
          <label>
            Country <small>(optional, 2-letter code)</small>
            <input name="country" defaultValue={store.country ?? ''} maxLength={2} placeholder="US" style={{ textTransform: 'uppercase' }} />
          </label>
          {error && (
            <p className="form-notice error" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="form-notice" role="status">
              {message}
            </p>
          )}
          <button className="cta" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save store details'}
          </button>
        </form>
      ) : null}
    </section>
  )
}
