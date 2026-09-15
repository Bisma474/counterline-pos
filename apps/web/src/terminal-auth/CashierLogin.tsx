import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import { currentAccess, lockTerminal, loginCashier, readTerminal, refreshTerminal, type TerminalCache } from './cache'
import './terminal-auth.css'

export function CashierLogin() {
  const [cache, setCache] = useState<TerminalCache>()
  const [employeeId, setEmployeeId] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [offlineReady, setOfflineReady] = useState(false)
  const [managerApproval, setManagerApproval] = useState(false)
  async function load() {
    const state = await currentAccess()
    setCache(state?.cache); setManagerApproval(state?.policy.managerApproval ?? false)
  }
  useEffect(() => {
    registerSW({ onOfflineReady: () => setOfflineReady(true), onRegisterError: () => setError('The offline app could not be cached. Keep this page open and retry online.') })
    let active = true
    const update = async () => {
      try { if (navigator.onLine && await readTerminal()) await refreshTerminal(); if (active) await load() }
      catch (reason) { if (active) { setError(reason instanceof Error ? reason.message : 'Unable to restore terminal access.'); await load() } }
      finally { if (active) setBusy(false) }
    }
    void update()
    const connection = () => { setOnline(navigator.onLine); if (navigator.onLine) { setBusy(true); void update() } }
    const interval = window.setInterval(() => { void load().catch(reason => setError(String(reason))) }, 5000)
    // Revalidate connected cashier permissions; changed access locks on refresh.
    const refresh = window.setInterval(() => { if (navigator.onLine) void update() }, 60_000)
    window.addEventListener('online', connection); window.addEventListener('offline', connection)
    return () => { active = false; clearInterval(interval); clearInterval(refresh); window.removeEventListener('online', connection); window.removeEventListener('offline', connection) }
  }, [])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget
    const pin = String(new FormData(form).get('pin'))
    form.reset(); setBusy(true); setError('')
    try { await loginCashier(employeeId, pin); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to unlock terminal.') }
    finally { setBusy(false) }
  }
  async function refresh() {
    setBusy(true); setError('')
    try { await refreshTerminal(); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to refresh terminal.'); await load() }
    finally { setBusy(false) }
  }
  const employee = cache?.employees.find(row => row.id === cache.session?.employee_id)
  return <main className="terminal-page"><header><Link to="/pos/login">Counterline · Cashier access</Link><Link to="/login">Owner or manager email sign in</Link></header><section className="terminal-card cashier-card"><p className="kicker">AT THE COUNTER</p><h1>{employee ? `Hello, ${employee.name}.` : 'Unlock your terminal.'}</h1><p role="status">{online ? 'Connected' : 'Offline'}{offlineReady ? ' · Offline sign-in app saved' : ''}</p>{error && <p className="form-notice error" role="alert">{error}</p>}{busy && <p role="status">Checking terminal access…</p>}{cache ? <><p><strong>{cache.device.name}</strong><small className="terminal-prefix">Receipt prefix: {cache.device.receipt_prefix}</small></p>{employee && cache.session ? <section aria-label="Cashier session"><h2>PIN access granted.</h2><p>{employee.role === 'manager' ? managerApproval ? 'Manager approval access is current.' : 'Manager approval requires online validation after 72 hours.' : 'Cashier access is current.'}</p><p>Register and checkout integration will be connected separately.</p><button className="cta" disabled={busy} onClick={() => { setBusy(true); void lockTerminal().then(load).catch(reason => setError(String(reason))).finally(() => setBusy(false)) }}>Lock terminal</button></section> : cache.employees.length ? <form onSubmit={event => void submit(event)}><label>Employee<select value={employeeId} required disabled={busy} onChange={event => setEmployeeId(event.target.value)}><option value="">Choose your name</option>{cache.employees.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>PIN<input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength={4} maxLength={8} autoComplete="off" required disabled={busy} /></label><button className="cta" type="submit" disabled={busy}>Unlock terminal</button></form> : <p>No cached employees are available. Ask a manager to add active employees, then refresh terminal access.</p>}<button type="button" disabled={!online || busy} onClick={() => void refresh()}>Refresh terminal access</button><p className="terminal-help">Offline PIN access lasts up to seven days after server validation. Five wrong attempts lock access for 60 seconds.</p></> : !busy && <><p>This browser needs online manager setup before cashier sign in.</p><Link className="cta" to="/settings/terminals">Set up terminal</Link></>}</section></main>
}
