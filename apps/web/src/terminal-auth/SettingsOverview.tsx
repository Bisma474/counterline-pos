import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { requireSupabase, supabase } from '../lib/supabase'
import { request } from './api'
import { readTerminal, type TerminalCache } from './cache'
import { TerminalState } from './TerminalStatus'
import type { Management } from './types'

interface StoreAccess { storeId: string; role: string }

function CardIcon({ children }: { children: string }) { return <span className="settings-icon" aria-hidden="true">{children}</span> }

export function SettingsOverview() {
  const [access, setAccess] = useState<StoreAccess>()
  const [management, setManagement] = useState<Management>({ employees: [], devices: [] })
  const [terminal, setTerminal] = useState<TerminalCache>()
  const [loading, setLoading] = useState(Boolean(supabase))
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = async () => {
    if (!supabase) { setLoading(false); return }
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError) throw userError
      if (!user) throw new Error('Sign in with your owner or manager email account.')
      const { data, error: membershipError } = await supabase.from('store_memberships').select('store_id, role').eq('user_id', user.id).eq('active', true).limit(1)
      if (membershipError) throw membershipError
      const membership = data?.[0]
      if (!membership) throw new Error('No active store membership was found.')
      setAccess({ storeId: membership.store_id, role: membership.role })
      if (membership.role === 'owner' || membership.role === 'manager') {
        const [nextManagement, nextTerminal] = await Promise.all([
          request<Management>(`/terminal-auth/manage/${membership.store_id}`, undefined, true),
          readTerminal(),
        ])
        setManagement(nextManagement)
        setTerminal(nextTerminal)
      }
    } catch (reason) { setLoadError(reason instanceof Error ? reason.message : 'Unable to load store settings.') }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!access) return
    setError(''); setMessage('')
    try {
      const form = new FormData(event.currentTarget)
      const { error: inviteError } = await requireSupabase().rpc('invite_store_member', { p_store_id: access.storeId, p_email: String(form.get('email')).trim(), p_role: String(form.get('role')) })
      if (inviteError) throw inviteError
      event.currentTarget.reset()
      setMessage('Invitation saved. The team member can accept it after signing in.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to invite this team member.') }
  }

  const canManagePos = access?.role === 'owner' || access?.role === 'manager'
  const activeDevices = management.devices.filter(device => !device.revoked_at).length
  const activeEmployees = management.employees.filter(employee => employee.active).length
  const lastSynced = terminal ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(terminal.validated_at)) : ''

  return <section className="settings-page settings-overview">
    <div className="settings-heading"><CardIcon>⚙</CardIcon><div><p className="kicker">STORE ADMINISTRATION</p><h1>Store settings</h1><p>Manage your team, POS terminals, and cashier access.</p></div></div>
    {loading ? <p className="form-notice" role="status">Loading store settings…</p> : loadError ? <p className="form-notice error" role="alert">{loadError}</p> : <>
      {canManagePos && <section aria-labelledby="pos-setup-title"><h2 id="pos-setup-title" className="settings-section-title">POS setup</h2><div className="pos-setup-cards">
        <article className="setup-card"><CardIcon>▣</CardIcon><div><div className="card-title"><h3>Terminals</h3><span className="count-badge">{activeDevices} active {activeDevices === 1 ? 'terminal' : 'terminals'}</span></div><p>Provision and manage the devices used at your checkout counters.</p><Link className="cta" to="/settings/terminals">Manage terminals <b aria-hidden="true">→</b></Link></div></article>
        <article className="setup-card"><CardIcon>♧</CardIcon><div><div className="card-title"><h3>Cashier employees</h3><span className="count-badge">{activeEmployees} active {activeEmployees === 1 ? 'cashier' : 'cashiers'}</span></div><p>Create cashier PIN access and control who can use the POS.</p><Link className="cta" to="/settings/employees">Manage employees <b aria-hidden="true">→</b></Link></div></article>
      </div></section>}
      <div className="settings-columns"><section className="team-section" aria-labelledby="store-team-title"><h2 id="store-team-title" className="settings-section-title">Store team</h2><p>Invite owners and managers who need email access to Counterline.</p>{canManagePos ? <form className="invite-form" onSubmit={submitInvite}><h3>Invite new team member</h3><label>Staff email<input name="email" type="email" autoComplete="email" placeholder="name@store.com" required /></label><label>Store role<select name="role" defaultValue="manager"><option value="manager">Manager</option><option value="cashier">Cashier</option></select></label><button className="cta" type="submit">Send invite <b aria-hidden="true">→</b></button></form> : <p className="form-notice">You do not have permission to manage this store.</p>}{error && <p className="form-notice error" role="alert">{error}</p>}{message && <p className="form-notice" role="status">{message}</p>}</section>
        <aside className="this-terminal-card"><h2>This terminal</h2>{terminal ? <><div className="terminal-summary"><CardIcon>▣</CardIcon><div><div className="card-title"><h3>{terminal.device.name}</h3><TerminalState terminal={terminal} /></div><p>Receipt prefix: <strong>{terminal.device.receipt_prefix}</strong></p></div></div><dl><div><dt>Receipt prefix</dt><dd>{terminal.device.receipt_prefix}</dd></div><div><dt>Last synced</dt><dd>{lastSynced}</dd></div></dl><Link className="secondary-cta" to="/settings/terminals">Manage terminal</Link></> : <div className="terminal-empty"><CardIcon>▣</CardIcon><h3>No terminal connected?</h3><p>Add a terminal to start processing sales and keep your store running.</p><Link className="cta" to="/settings/terminals">Add terminal <b aria-hidden="true">+</b></Link></div>}</aside>
      </div>
    </>}
  </section>
}
