import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Dexie, { liveQuery } from 'dexie'
import { formatCents } from '../../../../packages/domain/src/money'
import { posDb, type LocalOrder } from '../lib/db'
import { pushPendingOrders, retryOrder } from '../lib/order-sync'
import { saleDate, saleDay, syncLabel } from '../receipts/data'
import { receiptStore, useReceiptStore } from '../receipts/useReceiptStore'
import '../receipts/receipts.css'

export function OrderHistoryScreen({ terminal = false }: { terminal?: boolean }) {
  const scope = useReceiptStore(terminal)
  const [orders, setOrders] = useState<LocalOrder[]>()
  const [query, setQuery] = useState('')
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    setOrders(undefined); setError('')
    if (!scope.storeId) return
    const subscription = liveQuery(() => posDb.orders.where('[store_id+client_generated_at]')
      .between([scope.storeId, Dexie.minKey], [scope.storeId, Dexie.maxKey]).reverse().toArray())
      .subscribe({ next: setOrders, error: reason => setError(reason instanceof Error ? reason.message : 'Unable to load local orders.') })
    return () => subscription.unsubscribe()
  }, [scope.storeId])
  useEffect(() => {
    if (!scope.storeId) return
    const sync = async () => {
      try { if (await receiptStore(terminal) === scope.storeId) await pushPendingOrders(scope.storeId, terminal) }
      catch { /* Explicit sync reports errors; background retries preserve the local view. */ }
    }
    const handler = () => { if (navigator.onLine) void sync() }
    window.addEventListener('online', handler)
    const timer = window.setInterval(handler, 15_000)
    return () => { window.removeEventListener('online', handler); window.clearInterval(timer) }
  }, [scope.storeId, terminal])
  const sync = async (orderId?: string) => {
    if (!scope.storeId || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      if (!navigator.onLine) { setNotice('You are offline. Saved receipts remain available; reconnect to sync.'); return }
      if (await receiptStore(terminal) !== scope.storeId) throw new Error('Store access changed. Reload Orders before syncing.')
      if (orderId) await retryOrder(orderId, scope.storeId, terminal)
      else await pushPendingOrders(scope.storeId, terminal)
      setNotice('Sync attempt finished. Check each order status below; pending or rejected sales remain saved.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not sync orders.') }
    finally { setBusy(false) }
  }
  const visible = orders?.filter(order => (!date || saleDay(order) === date) &&
    `${order.receipt_number} ${saleDate(order)} ${saleDay(order)}`.toLowerCase().includes(query.trim().toLowerCase())) ?? []
  return <section className="order-history receipt-history"><p className="kicker">LOCAL ORDER HISTORY</p><h1>Orders.</h1>
    <p className="screen-note">Sales saved for this store in this browser. Dates use the timezone recorded on each sale.</p>
    <div className="receipt-actions"><Link to={terminal ? '/pos/register' : '/register'}>New sale</Link></div>
    <div className="history-tools"><label>Find receipt or date<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Receipt number or date" /></label>
      <label>Sale date<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
      {(query || date) && <button type="button" onClick={() => { setQuery(''); setDate('') }}>Clear search</button>}
      <button type="button" onClick={() => void sync()} disabled={busy || !scope.storeId}>{busy ? 'Syncing...' : 'Sync pending orders'}</button></div>
    {(scope.error || error) && <div className="form-notice error" role="alert"><p>{scope.error || error}</p><button type="button" onClick={scope.retry}>Reload orders</button></div>}
    <p role="status">{notice}</p>
    {!scope.error && !error && orders === undefined && <p role="status">Loading saved orders...</p>}
    {orders?.length === 0 && <p>No orders have been saved for this store in this browser yet.</p>}
    {Boolean(orders?.length) && !visible.length && <p>No orders match your search.</p>}
    <div className="history-list">{visible.map(order => {
      // Determine if this order can be retried
      const canRetry = order.sync_status === 'pending' && Boolean(order.failure_reason)
      // Human-friendly failure message
      const failureMsg = order.failure_reason
        ? order.failure_reason.includes('customer link')
            ? order.failure_reason   // already descriptive from our new sync core message
            : order.failure_reason
        : null
      return (
        <article key={order.id}>
          <div><strong>{order.receipt_number}</strong><small>{saleDate(order)} | {order.timezone_snapshot}</small></div>
          <b>{formatCents(order.total_cents, order.currency)}</b>
          <span className={`order-state ${order.sync_status}`}>{syncLabel(order)}</span>
          <Link className="receipt-detail-link" to={`${terminal ? '/pos/orders' : '/orders'}/${encodeURIComponent(order.id)}`}>View receipt / print</Link>
          {canRetry && <button type="button" disabled={busy} onClick={() => void sync(order.id)}>Retry now</button>}
          {failureMsg && <p className="history-reason">{failureMsg}</p>}
        </article>
      )
    })}</div>
  </section>
}
