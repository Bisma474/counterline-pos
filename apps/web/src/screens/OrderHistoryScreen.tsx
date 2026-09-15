import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { formatCents } from '../../../../packages/domain/src/money'
import { posDb, type LocalOrder, type LocalOrderItem, type LocalPayment } from '../lib/db'
import { pushPendingOrders } from '../lib/order-sync'

export function OrderHistoryScreen() {
  const location = useLocation()
  const completed = (location.state as { completed?: string } | null)?.completed
  const [orders, setOrders] = useState<LocalOrder[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<{ order: LocalOrder; items: LocalOrderItem[]; payment: LocalPayment | undefined } | null>(null)
  const refresh = async () => setOrders((await posDb.orders.orderBy('client_generated_at').reverse().toArray()))
  useEffect(() => { void refresh(); const handler = () => void pushPendingOrders().then(refresh).catch(() => undefined)
    window.addEventListener('online', handler)
    const timer = window.setInterval(() => { void refresh(); if (navigator.onLine) void pushPendingOrders().then(refresh).catch(() => undefined) }, 15_000)
    return () => { window.removeEventListener('online', handler); window.clearInterval(timer) } }, [])
  const sync = async () => { setBusy(true); setError(''); try { await pushPendingOrders(); await refresh() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not sync orders.') } finally { setBusy(false) } }
  const show = async (order: LocalOrder) => setSelected({ order, items: await posDb.order_items.where('order_id').equals(order.id).toArray(),
    payment: await posDb.payments.where('order_id').equals(order.id).first() })
  const visible = orders.filter(order => `${order.receipt_number} ${order.client_generated_at}`.toLowerCase().includes(query.toLowerCase()))
  return <section className="order-history"><p className="kicker">LOCAL ORDER HISTORY</p><h1>Orders.</h1>
    {completed && <p className="form-notice" role="status">Sale {completed} saved in this browser. Sync may still be pending.</p>}
    <div className="history-tools"><label>Find receipt or date<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Receipt number or date" /></label>
      <button type="button" onClick={() => void sync()} disabled={busy}>{busy ? 'Syncing…' : 'Sync pending orders'}</button></div>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {!orders.length && <p>No orders have been saved in this browser yet.</p>}
    {orders.length > 0 && !visible.length && <p>No orders match your search.</p>}
    <div className="history-list">{visible.map(order => <article key={order.id}><div><strong>{order.receipt_number}</strong><small>{new Date(order.client_generated_at).toLocaleString()}</small></div>
      <b>{formatCents(order.total_cents, order.currency)}</b><span className={`order-state ${order.sync_status}`}>{order.sync_status === 'failed' ? 'Rejected / needs review' : order.sync_status === 'synced' ? 'Synced' : 'Pending sync'}</span>
      <button type="button" onClick={() => void show(order)}>Details</button>
      {order.failure_reason && <p className="history-reason">{order.failure_reason}</p>}</article>)}</div>
    {selected && <div className="history-detail"><button type="button" onClick={() => setSelected(null)}>Close</button><h2>{selected.order.receipt_number}</h2>
      <p>{selected.order.store_name_snapshot} · {new Date(selected.order.client_generated_at).toLocaleString()}</p>
      {selected.items.map(item => <p key={item.id}>{item.quantity} × {item.snapshot_name} — {formatCents(item.total_cents, selected.order.currency)}</p>)}
      <p>Subtotal {formatCents(selected.order.subtotal_cents, selected.order.currency)} · Tax {formatCents(selected.order.tax_cents, selected.order.currency)}</p>
      <strong>Total {formatCents(selected.order.total_cents, selected.order.currency)}</strong>
      <p>Payment: {selected.payment?.method ?? 'Unknown'} · Tendered {formatCents(selected.payment?.tendered_cents ?? 0, selected.order.currency)} · Change {formatCents(selected.payment?.change_cents ?? 0, selected.order.currency)}</p>
      <p>Sync: {selected.order.sync_status}{selected.order.failure_reason ? ` — ${selected.order.failure_reason}` : ''}</p>
      <button type="button" onClick={() => window.print()}>Print duplicate receipt</button></div>}
  </section>
}
