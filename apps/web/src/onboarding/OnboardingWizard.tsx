import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../App'
import { requireSupabase } from '../lib/supabase'
import { loadCatalog } from '../lib/catalog'
import { provisionTerminal } from '../terminal-auth/cache'
import { request } from '../terminal-auth/api'
import '../terminal-auth/terminal-auth.css'

type Store = { id: string; name: string; timezone: string; currency: string }
const CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD'] as const
const STEPS = ['Store profile', 'Terminal', 'Staff'] as const

export function OnboardingWizard() {
  const go = useNavigate()
  const { markOnboardingComplete } = useSession()
  const [step, setStep] = useState(0)
  const [store, setStore] = useState<Store>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [terminalDone, setTerminalDone] = useState(false)
  const [staffDone, setStaffDone] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const client = requireSupabase()
        const { data: { user }, error: userError } = await client.auth.getUser()
        if (userError) throw userError
        if (!user) throw new Error('Your session could not be restored. Please sign in again.')
        const { data: memberships, error: membershipError } = await client.from('store_memberships').select('store_id').eq('user_id', user.id).eq('active', true).eq('role', 'owner').limit(1)
        if (membershipError) throw membershipError
        const storeId = memberships?.[0]?.store_id
        if (!storeId) throw new Error('No store was found for this account.')
        const { data: storeRow, error: storeError } = await client.from('stores').select('id,name,timezone,currency,onboarding_completed_at').eq('id', storeId).single()
        if (storeError) throw storeError
        if (storeRow.onboarding_completed_at) { go('/dashboard', { replace: true }); return }
        if (active) setStore({ id: storeRow.id, name: storeRow.name, timezone: storeRow.timezone, currency: storeRow.currency })
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load your store.') }
      finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [go])

  async function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!store) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name')).trim()
    const currency = String(form.get('currency'))
    const timezone = String(form.get('timezone')).trim()
    setBusy(true); setError('')
    try {
      const client = requireSupabase()
      const { error: updateError } = await client.rpc('update_store_profile', { p_store_id: store.id, p_name: name, p_timezone: timezone, p_currency: currency })
      if (updateError) throw updateError
      setStore({ ...store, name, currency, timezone })
      setStep(1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save the store profile.') }
    finally { setBusy(false) }
  }

  async function submitTerminal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!store) return
    const name = String(new FormData(event.currentTarget).get('name')).trim()
    setBusy(true); setError('')
    try {
      await provisionTerminal(store.id, name)
      setTerminalDone(true)
      setStep(2)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to provision this terminal.') }
    finally { setBusy(false) }
  }

  async function submitStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!store) return
    const form = new FormData(event.currentTarget)
    setBusy(true); setError('')
    try {
      try {
        await request('/terminal-auth/employees', { store_id: store.id, name: String(form.get('name')).trim(), role: 'cashier', active: true, pin: String(form.get('pin') ?? '') }, true)
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to add this employee.'); return }
      setStaffDone(true)
      await finish()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The employee was added, but setup could not be finished. Try again.') }
    finally { setBusy(false) }
  }

  async function finish() {
    if (!store) return
    const client = requireSupabase()
    const { error: completeError } = await client.rpc('complete_store_onboarding', { p_store_id: store.id })
    if (completeError) throw completeError
    await loadCatalog(store.id).catch(() => undefined)
    markOnboardingComplete()
    go('/dashboard', { replace: true })
  }

  if (loading) return <main className="route-pending" role="status">Loading…</main>
  if (error && !store) return <main className="onboarding-page"><div className="form-card"><p role="alert" className="form-notice error">{error}</p></div></main>

  return <main className="onboarding-page">
    <div className="form-card onboarding-wizard">
      <p className="kicker">STEP {step + 1} OF {STEPS.length}</p>
      <h2>{STEPS[step]}</h2>
        {error && <p role="alert" className="form-notice error">{error}</p>}
        {step === 0 && store && <form onSubmit={event => void submitProfile(event)} noValidate>
          <p className="form-copy">Confirm the details customers and receipts will use.</p>
          <label>Store name<input name="name" defaultValue={store.name} required minLength={2} maxLength={120} /></label>
          <label>Currency<select name="currency" defaultValue={store.currency}>{CURRENCIES.map(code => <option key={code} value={code}>{code}</option>)}</select></label>
          <label>Timezone<input name="timezone" defaultValue={store.timezone} required /></label>
          <button className="cta" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Continue'}<b aria-hidden="true">→</b></button>
        </form>}
        {step === 1 && <form onSubmit={event => void submitTerminal(event)} noValidate>
          <p className="form-copy">Provision this browser as your first checkout terminal.</p>
          <label>Terminal name<input name="name" required maxLength={80} placeholder="Front Counter 1" autoComplete="off" /></label>
          <button className="cta" type="submit" disabled={busy}>{busy ? 'Provisioning…' : 'Continue'}<b aria-hidden="true">→</b></button>
        </form>}
        {step === 2 && <form onSubmit={event => void submitStaff(event)} noValidate>
          <p className="form-copy">Add a cashier PIN so your team can start selling.</p>
          <label>Cashier name<input name="name" required maxLength={80} autoComplete="off" /></label>
          <label>PIN<input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength={4} maxLength={8} required autoComplete="new-password" /></label>
          <button className="cta" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Finish setup'}<b aria-hidden="true">→</b></button>
        </form>}
        <p className="onboarding-progress" aria-hidden="true">{STEPS.map((label, index) => <span key={label} className={index === step ? 'active' : index < step || (index === 1 && terminalDone) || (index === 2 && staffDone) ? 'done' : ''}>{label}</span>)}</p>
    </div>
  </main>
}
