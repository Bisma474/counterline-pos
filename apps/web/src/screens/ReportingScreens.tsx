import { useEffect, useState, type ReactNode } from 'react'
import { liveQuery } from 'dexie'
import { Link } from 'react-router-dom'
import { formatCents } from '../../../../packages/domain/src/money'
import { posDb, type StoreConfig } from '../lib/db'
import { resolveFinancialAccess } from '../lib/management-access'
import { calculateLocalSalesReport, todayInTimezone, type LocalSalesReport } from '../lib/reporting'
import { currentAccess } from '../terminal-auth/cache'
import { configuredApiUrl } from '../lib/catalog'
import './reporting.css'

interface ReportState { config: StoreConfig; report: LocalSalesReport }

function useFinancialReport(day?: string) {
  const [state, setState] = useState<ReportState>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    let subscription: { unsubscribe(): void } | undefined
    setState(undefined); setError('')
    void resolveFinancialAccess().then(async access => {
      const config = await posDb.store_config.get(access.storeId)
      if (!config) throw new Error('No store configuration is saved in this browser. Open the register online once.')
      const reportDay = day || todayInTimezone(config.timezone)
      subscription = liveQuery(async () => calculateLocalSalesReport(access.storeId, reportDay, config.timezone, {
        orders: await posDb.orders.where('store_id').equals(access.storeId).toArray(),
        items: await posDb.order_items.toArray(), payments: await posDb.payments.toArray(),
        outbox: await posDb.outbox.where('store_id').equals(access.storeId).toArray(),
      })).subscribe({ next: report => { if (active) setState({ config, report }) }, error: reason => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to calculate reporting totals.') } })
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Reporting access could not be verified.') })
    return () => { active = false; subscription?.unsubscribe(); setState(undefined) }
  }, [day])
  return { state, error }
}

const Money = ({ cents, currency }: { cents: number; currency: string }) => <>{formatCents(cents, currency)}</>

export function OwnerDashboardScreen() {
  const { state, error } = useFinancialReport()
  if (error) return <AccessMessage message={error} />
  if (!state) return <section className="reporting-page" role="status">Checking reporting access and local sales…</section>
  const { report, config } = state
  return <section className="reporting-page"><header className="reporting-heading"><div><p className="kicker">THIS BROWSER / REGISTER-LOCAL</p><h1>Today at a glance.</h1><p>Recorded sales for today in {config.timezone}. Pending and rejected sales remain included.</p></div><Link className="report-primary" to="/register">Open register <span aria-hidden="true">→</span></Link></header>
    <div className="report-card-grid">
      <ReportCard label="Today’s recorded sales" value={<Money cents={report.recordedTotalCents} currency={config.currency} />} detail="Completed locally" />
      <ReportCard label="Completed orders" value={report.completedOrderCount} detail="Saved in this browser" />
      <ReportCard label="Average sale" value={<Money cents={report.averageSaleCents} currency={config.currency} />} detail="Recorded total ÷ orders" />
      <ReportCard label="Items sold" value={report.itemsSold} detail="Total item quantity" />
    </div>
    <section className="unresolved-panel"><div><h2>Sync status</h2><p>These totals are recorded locally and may not yet be accepted by the server.</p></div><StatusAmount label="Pending" count={report.pendingCount} cents={report.pendingAmountCents} currency={config.currency} /><StatusAmount label="Rejected" count={report.rejectedCount} cents={report.rejectedAmountCents} currency={config.currency} rejected /></section>
  </section>
}

export function ReportsScreen() {
  const [day, setDay] = useState('')
  const { state, error } = useFinancialReport(day || undefined)
  useEffect(() => { if (state && !day) setDay(todayInTimezone(state.config.timezone)) }, [state, day])
  return <section className="reporting-page reports-detail"><header className="reporting-heading"><div><p className="kicker">THIS BROWSER / REGISTER-LOCAL</p><h1>Daily sales report.</h1><p>Calendar days use the saved store timezone and the recorded sale time.</p></div>{state && <label className="day-picker">Report date<input type="date" value={day} onChange={event => setDay(event.target.value)} /></label>}</header>
    {error && <AccessMessage message={error} embedded />}
    {!error && !state && <p role="status">Checking reporting access and local sales…</p>}
    {state && <><div className="report-metrics">
      <ReportLine label="Gross sales" hint="Subtotal before discounts and tax" cents={state.report.grossSalesCents} currency={state.config.currency} />
      <ReportLine label="Discounts" hint="Older records count as zero" cents={state.report.discountCents} currency={state.config.currency} />
      <ReportLine label="Net sales" hint="Gross sales minus discounts" cents={state.report.netSalesCents} currency={state.config.currency} />
      <ReportLine label="Tax collected" hint="Recorded tax amounts" cents={state.report.taxCents} currency={state.config.currency} />
      <ReportLine label="Cash takings" hint="Payment amount; change excluded" cents={state.report.cashTakingsCents} currency={state.config.currency} />
      <ReportLine label="Card takings" hint="Recorded external-card payments" cents={state.report.cardTakingsCents} currency={state.config.currency} />
      <ReportLine label="Recorded total" hint={`${state.report.completedOrderCount} completed order${state.report.completedOrderCount === 1 ? '' : 's'}`} cents={state.report.recordedTotalCents} currency={state.config.currency} emphasized />
    </div><section className="unresolved-panel"><div><h2>Unresolved sales</h2><p>Included in recorded totals and shown separately here.</p></div><StatusAmount label="Pending" count={state.report.pendingCount} cents={state.report.pendingAmountCents} currency={state.config.currency} /><StatusAmount label="Rejected" count={state.report.rejectedCount} cents={state.report.rejectedAmountCents} currency={state.config.currency} rejected /></section></>}
  </section>
}

export function CashierDashboardScreen() {
  const [state, setState] = useState<{ cashier: string; terminal: string; storeId: string; online: boolean; pending: number; rejected: number }>()
  const [apiReachable, setApiReachable] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    let subscription: { unsubscribe(): void } | undefined
    const load = async () => {
      const access = await currentAccess()
      if (!access?.cache || !access.employee || !access.policy.valid) throw new Error('Cashier access is no longer valid.')
      const { cache, employee } = access
      subscription = liveQuery(async () => {
        const entries = await posDb.outbox.where('store_id').equals(cache.device.store_id).toArray()
        return { cashier: employee.name, terminal: cache.device.name, storeId: cache.device.store_id, online: navigator.onLine,
          pending: entries.filter(entry => entry.status === 'pending').length,
          rejected: entries.filter(entry => entry.status === 'failed' || entry.failure_kind === 'validation').length }
      }).subscribe(value => { if (active) setState(value) })
    }
    void load().catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load terminal status.') })
    const connection = () => setState(previous => previous ? { ...previous, online: navigator.onLine } : previous)
    window.addEventListener('online', connection); window.addEventListener('offline', connection)
    return () => { active = false; subscription?.unsubscribe(); window.removeEventListener('online', connection); window.removeEventListener('offline', connection); setState(undefined) }
  }, [])
  useEffect(() => {
    let active = true
    const checkApi = async () => {
      if (!navigator.onLine) { if (active) setApiReachable(false); return }
      try {
        const response = await fetch(`${configuredApiUrl()}/health`, { signal: AbortSignal.timeout(3_000) })
        if (active) setApiReachable(response.ok)
      } catch { if (active) setApiReachable(false) }
    }
    void checkApi()
    const timer = window.setInterval(() => void checkApi(), 15_000)
    window.addEventListener('online', checkApi); window.addEventListener('offline', checkApi)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('online', checkApi); window.removeEventListener('offline', checkApi) }
  }, [])
  if (error) return <AccessMessage message={error} />
  if (!state) return <section className="reporting-page" role="status">Loading terminal status…</section>
  return <section className="reporting-page cashier-dashboard"><header className="reporting-heading"><div><p className="kicker">CASHIER WORKSPACE</p><h1>Ready for the counter.</h1><p>Operational status for this terminal. Financial summaries are available to authorized management.</p></div><Link className="report-primary" to="/pos/register">Open register <span aria-hidden="true">→</span></Link></header><div className="operational-grid">
    <ReportCard label="Active cashier" value={state.cashier} detail="Current authorized session" />
    <ReportCard label="Terminal" value={state.terminal} detail="Provisioned device" />
    <ReportCard label="Connectivity" value={!state.online ? 'Offline' : apiReachable === null ? 'Checking API' : apiReachable ? 'API reachable' : 'API unreachable'} detail={apiReachable ? 'Sync is available' : 'Sales remain local'} />
    <ReportCard label="Pending sync" value={state.pending} detail={state.rejected ? `${state.rejected} need review` : 'No rejected operations'} />
  </div>{state.rejected > 0 && <p className="operation-warning" role="status">{state.rejected} sync operation{state.rejected === 1 ? '' : 's'} need review. Ask a manager for help.</p>}</section>
}

function AccessMessage({ message, embedded = false }: { message: string; embedded?: boolean }) { return <section className={embedded ? 'report-access embedded' : 'reporting-page report-access'} role="alert"><h2>Reporting unavailable</h2><p>{message}</p></section> }
function ReportCard({ label, value, detail }: { label: string; value: ReactNode; detail: string }) { return <article className="report-card"><small>{label}</small><strong>{value}</strong><span>{detail}</span></article> }
function StatusAmount({ label, count, cents, currency, rejected = false }: { label: string; count: number; cents: number; currency: string; rejected?: boolean }) { return <article className={rejected ? 'status-amount rejected' : 'status-amount'}><small>{label}</small><strong>{count}</strong><span><Money cents={cents} currency={currency} /></span></article> }
function ReportLine({ label, hint, cents, currency, emphasized = false }: { label: string; hint: string; cents: number; currency: string; emphasized?: boolean }) { return <article className={emphasized ? 'report-line emphasized' : 'report-line'}><div><strong>{label}</strong><small>{hint}</small></div><b><Money cents={cents} currency={currency} /></b></article> }
