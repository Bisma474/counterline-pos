import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { requireSupabase } from '../lib/supabase'
import { request } from './api'
import { saveProjection, withTerminalLock } from './cache'
import type { ManagedEmployee, Management, Projection } from './types'
import './terminal-auth.css'

export function ManagerSetup({ screen }: { screen: 'terminals' | 'employees' }) {
  const [stores, setStores] = useState<{ id: string; name: string }[]>([])
  const [storeId, setStoreId] = useState('')
  const [management, setManagement] = useState<Management>({ employees: [], devices: [] })
  const [editing, setEditing] = useState<ManagedEmployee>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => { setEditing(undefined); setMessage('') }, [screen])
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const client = requireSupabase()
        const { data: { user }, error: userError } = await client.auth.getUser()
        if (userError) throw userError
        if (!user) throw new Error('Sign in with your owner or manager email account.')
        const { data, error: membershipError } = await client.from('store_memberships').select('store_id').eq('user_id', user.id).eq('active', true).in('role', ['owner', 'manager'])
        if (membershipError) throw membershipError
        if (!data?.length) throw new Error('An active owner or manager membership is required.')
        const result = await client.from('stores').select('id,name').in('id', data.map(row => row.store_id))
        if (result.error) throw result.error
        if (active) { setStores(result.data); setStoreId(result.data[0]?.id ?? '') }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load stores.') }
      finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!storeId) return
    let active = true
    setLoading(true); setError(''); setEditing(undefined); setManagement({ employees: [], devices: [] })
    void request<Management>(`/terminal-auth/manage/${storeId}`, undefined, true)
      .then(data => { if (active) setManagement(data) })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load terminal setup.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [storeId])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget, values = new FormData(form)
    setBusy(true); setError(''); setMessage('')
    try {
      if (screen === 'terminals') {
        await withTerminalLock(async () => {
          const projection = await request<Projection>('/devices/provision', { store_id: storeId, name: String(values.get('name')).trim() }, true)
          await saveProjection(projection)
        })
        setMessage('This browser is provisioned. Open cashier sign in to unlock the terminal.')
      } else {
        await request('/terminal-auth/employees', { store_id: storeId, id: editing?.id, name: String(values.get('name')).trim(), role: values.get('role'), active: values.get('active') === 'on', pin: String(values.get('pin') ?? '') }, true)
        setEditing(undefined)
        setMessage('Employee saved. Refresh connected terminals to update offline access.')
      }
      form.reset()
      setManagement(await request<Management>(`/terminal-auth/manage/${storeId}`, undefined, true))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save setup.') }
    finally { setBusy(false) }
  }
  async function revoke(id: string) {
    setBusy(true); setError(''); setMessage('')
    try {
      await request(`/terminal-auth/devices/${id}/revoke`, { store_id: storeId }, true)
      setManagement(await request<Management>(`/terminal-auth/manage/${storeId}`, undefined, true))
      setMessage('Terminal revoked. Offline access expires within its existing seven-day window; connected terminals lock on refresh.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to revoke terminal.') }
    finally { setBusy(false) }
  }
  return <main className="terminal-page"><header><Link to="/dashboard">Counterline · Store workspace</Link><nav aria-label="Terminal administration"><Link to="/settings/terminals">Terminals</Link><Link to="/settings/employees">Employees</Link><Link to="/pos/login">Cashier sign in</Link></nav></header><section className="terminal-card"><p className="kicker">OWNER & MANAGER SETUP</p><h1>{screen === 'terminals' ? 'Set up this terminal.' : 'Cashier access.'}</h1><p>{screen === 'terminals' ? 'Provision this browser online to assign a terminal identity and a unique receipt prefix.' : 'Create employee PIN access for the counter. Manager PIN roles permit local approvals within the authorization window.'}</p>{error && <p role="alert" className="form-notice error">{error}</p>}{message && <p role="status" className="form-notice">{message}</p>}<label>Store<select value={storeId} onChange={event => { setStoreId(event.target.value); setMessage('') }} disabled={busy || loading}>{!stores.length && <option value="">No managed stores available</option>}{stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>{loading ? <p role="status">Loading store access…</p> : storeId && <><form key={`${screen}-${editing?.id ?? 'new'}`} onSubmit={event => void submit(event)}><fieldset disabled={busy}><legend>{screen === 'terminals' ? 'Browser installation' : editing ? 'Edit employee' : 'New employee'}</legend><label>{screen === 'terminals' ? 'Terminal name' : 'Cashier name'}<input name="name" required maxLength={80} defaultValue={editing?.name} autoComplete="off" /></label>{screen === 'employees' && <><label>{editing ? 'New PIN (leave blank to keep current PIN)' : 'PIN'}<input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength={4} maxLength={8} required={!editing} autoComplete="new-password" aria-describedby="pin-help" /></label><p id="pin-help">Use 4 to 8 digits. Give each employee their own PIN.</p><label>POS role<select name="role" defaultValue={editing?.role ?? 'cashier'}><option value="cashier">Cashier</option><option value="manager">Manager</option></select></label><label className="terminal-check"><input name="active" type="checkbox" defaultChecked={editing?.active ?? true} />Active employee</label></>}<button className="cta" type="submit">{busy ? 'Saving…' : screen === 'terminals' ? 'Provision this browser' : editing ? 'Save employee' : 'Create employee'}</button>{editing && <button type="button" onClick={() => setEditing(undefined)}>Cancel edit</button>}</fieldset></form><h2>{screen === 'terminals' ? 'Store terminals' : 'Employees'}</h2><ul className="terminal-list">{screen === 'terminals' ? management.devices.map(device => <li key={device.id}><strong>{device.name}</strong><span>{device.revoked_at ? 'Revoked' : 'Active'}</span><small>Receipt prefix: {device.receipt_prefix}</small>{!device.revoked_at && <button type="button" disabled={busy} onClick={() => void revoke(device.id)}>Revoke {device.name}</button>}</li>) : management.employees.map(employee => <li key={employee.id}><strong>{employee.name}</strong><span>{employee.role} · {employee.active ? 'Active' : 'Inactive'}</span><button type="button" disabled={busy} onClick={() => { setEditing(employee); setMessage('') }}>Edit {employee.name}</button></li>)}</ul>{(screen === 'terminals' ? !management.devices.length : !management.employees.length) && <p>No {screen} yet.</p>}</>}</section></main>
}
