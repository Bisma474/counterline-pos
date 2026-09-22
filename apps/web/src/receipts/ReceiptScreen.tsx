import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigationType, useParams } from 'react-router-dom'
import { liveQuery } from 'dexie'
import { formatCents } from '../../../../packages/domain/src/money'
import { readReceipt, refundedQuantity, syncLabel, type SavedReceipt } from './data'
import { ReceiptOutput } from './ReceiptOutput'
import { useReceiptStore } from './useReceiptStore'
import { accessToken, configuredApiUrl } from '../lib/catalog'
import { posDb } from '../lib/db'
import { requireSupabase } from '../lib/supabase'

export function ReceiptScreen({ terminal = false }: { terminal?: boolean }) {
  const { orderId = '' } = useParams()
  const location = useLocation()
  // Navigation state only controls the initial-print label. Data always comes from Dexie.
  const navigationType = useNavigationType()
  const fresh = navigationType !== 'POP' && (location.state as { committedOrderId?: string } | null)?.committedOrderId === orderId
  const scope = useReceiptStore(terminal)
  const [receipt, setReceipt] = useState<SavedReceipt | null>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setReceipt(undefined); setError('')
    if (!scope.storeId) return
    const subscription = liveQuery(() => readReceipt(scope.storeId, orderId)).subscribe({ next: setReceipt,
      error: reason => setError(reason instanceof Error ? reason.message : 'Unable to read this receipt.') })
    return () => subscription.unsubscribe()
  }, [scope.storeId, orderId, attempt])
  const failure = scope.error || error

  // Refund is an owner/manager-only, web-session action (never on a cashier terminal) — resolve
  // that role the same way RegisterScreen resolves customer-access authorization.
  const [canRefund, setCanRefund] = useState(false)
  const [refunding, setRefunding] = useState(false)
  const [refundError, setRefundError] = useState('')
  useEffect(() => {
    if (terminal || !scope.storeId) return
    let active = true
    void (async () => {
      try {
        const client = requireSupabase()
        const { data: { user } } = await client.auth.getUser()
        if (!user) return
        const { data } = await client.from('store_memberships').select('role').eq('user_id', user.id).eq('store_id', scope.storeId).eq('active', true).limit(1)
        if (active) setCanRefund(data?.[0]?.role === 'owner' || data?.[0]?.role === 'manager')
      } catch { /* silent — the refund action just stays hidden if role resolution fails */ }
    })()
    return () => { active = false }
  }, [terminal, scope.storeId])

  // Which quantity of each still-refundable line the manager has selected to return, keyed by
  // order_item_id. Reset whenever the receipt reloads with a different order.
  const [selected, setSelected] = useState<Record<string, number>>({})
  useEffect(() => { setSelected({}) }, [orderId])

  const toggleItem = (itemId: string, remaining: number) => {
    setSelected(prev => {
      if (itemId in prev) { const { [itemId]: _removed, ...rest } = prev; return rest }
      return { ...prev, [itemId]: remaining }
    })
  }
  const setItemQuantity = (itemId: string, remaining: number, raw: number) => {
    const quantity = Math.max(1, Math.min(remaining, Math.trunc(raw) || 1))
    setSelected(prev => ({ ...prev, [itemId]: quantity }))
  }

  // "Refunded" (the summary banner) is derived straight from the local refunds/refund_items
  // tables (written below right after a successful call), not from transient component state —
  // readReceipt()'s liveQuery already tracks refund_items, so this reactively updates the same way
  // the old single refunded_at field used to, and now correctly across any number of separate
  // partial refunds instead of just one.
  const submitRefund = async () => {
    if (!receipt || refunding) return
    const items = Object.entries(selected).filter(([, quantity]) => quantity > 0).map(([order_item_id, quantity]) => ({ order_item_id, quantity }))
    if (!items.length) { setRefundError('Select at least one item to refund.'); return }
    const summary = items.map(({ order_item_id, quantity }) => `${quantity} × ${receipt.items.find(item => item.id === order_item_id)?.snapshot_name ?? 'item'}`).join(', ')
    if (!window.confirm(`Refund ${summary} from receipt ${receipt.order.receipt_number}? This cannot be undone.`)) return
    setRefunding(true)
    setRefundError('')
    try {
      const token = await accessToken()
      const response = await fetch(`${configuredApiUrl()}/orders/${receipt.order.id}/refund`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ store_id: receipt.order.store_id, operation_id: crypto.randomUUID(), items }),
      })
      const data = (await response.json()) as {
        code?: string; message?: string
        refund?: { id: string; amount_cents: string; reason: string | null; refunded_by: string; created_at: string }
        items?: Array<{ order_item_id: string; product_id: string; quantity: number; amount_cents: number }>
      }
      if (!response.ok || !data.refund || !data.items) throw new Error(data.message ?? `Server error (${response.status})`)
      const refund = data.refund
      const refundedItems = data.items
      await posDb.transaction('rw', posDb.refunds, posDb.refund_items, posDb.orders, async () => {
        await posDb.refunds.put({
          id: refund.id, store_id: receipt.order.store_id, order_id: receipt.order.id,
          amount_cents: Number(refund.amount_cents), reason: refund.reason, refunded_by: refund.refunded_by, created_at: refund.created_at,
        })
        await posDb.refund_items.bulkPut(refundedItems.map(item => ({
          id: `${refund.id}:${item.order_item_id}`, refund_id: refund.id, order_item_id: item.order_item_id,
          product_id: item.product_id, quantity: item.quantity, amount_cents: item.amount_cents,
        })))
        // Best-effort summary fields for screens that only need "was this ever refunded, roughly
        // how much" (e.g. the order-history list) — the refunds/refund_items tables above are the
        // source of truth for anything that needs per-line or per-event precision.
        await posDb.orders.update(receipt.order.id, {
          refunded_at: new Date().toISOString(),
          refunded_amount_cents: (receipt.order.refunded_amount_cents ?? 0) + Number(refund.amount_cents),
        })
      })
      setSelected({})
    } catch (reason) {
      setRefundError(reason instanceof Error ? reason.message : 'Could not refund this order.')
    } finally {
      setRefunding(false)
    }
  }

  const totalRefundedCents = receipt?.refundItems.reduce((sum, entry) => sum + entry.amount_cents, 0) ?? 0
  const refundableLines = receipt?.items.map(item => ({ item, remaining: item.quantity - refundedQuantity(item.id, receipt.refundItems) })) ?? []
  const anyRefundable = refundableLines.some(line => line.remaining > 0)

  return <section className="receipt-page"><p className="kicker">SAVED LOCAL SALE</p><h1>Receipt.</h1>
    <div className="receipt-actions"><Link to={terminal ? '/pos/orders' : '/orders'}>← Back to orders</Link><Link to={terminal ? '/pos/register' : '/register'}>New sale →</Link></div>
    {failure ? <div role="alert"><p>{failure}</p><button type="button" onClick={() => { scope.retry(); setAttempt(value => value + 1) }}>Try again</button></div>
      : receipt === undefined ? <p role="status">Loading saved receipt…</p>
      : receipt === null ? <div role="status"><h2>Receipt not found</h2><p>This receipt is not saved for this store in this browser. Check Orders on the terminal that recorded the sale.</p></div>
      : <><p role="status">{fresh ? 'Sale saved in this browser. ' : ''}{syncLabel(receipt.order)}{receipt.order.failure_reason ? ` — ${receipt.order.failure_reason}` : ''}</p>
        <ReceiptOutput key={receipt.order.id} receipt={receipt} fresh={fresh} />
        {canRefund && receipt.order.sync_status === 'synced' && <div className="refund-action">
          {totalRefundedCents > 0 && <p role="status">Refunded {formatCents(totalRefundedCents, receipt.order.currency)} so far.</p>}
          {anyRefundable ? <>
            <h3>Refund items</h3>
            <div className="refund-item-picker">
              {refundableLines.map(({ item, remaining }) => remaining <= 0
                ? <p key={item.id} className="refund-item-exhausted">{item.snapshot_name} — fully refunded</p>
                : <div key={item.id} className="refund-item-row">
                    <label>
                      <input type="checkbox" checked={item.id in selected} disabled={refunding} onChange={() => toggleItem(item.id, remaining)} />
                      {item.snapshot_name} ({remaining} of {item.quantity} refundable)
                    </label>
                    {item.id in selected && <input type="number" min={1} max={remaining} value={selected[item.id]} disabled={refunding}
                      onChange={event => setItemQuantity(item.id, remaining, Number(event.target.value))} aria-label={`Quantity of ${item.snapshot_name} to refund`} />}
                  </div>)}
            </div>
            <button type="button" className="cta" onClick={() => void submitRefund()} disabled={refunding || !Object.keys(selected).length}>
              {refunding ? 'Refunding…' : 'Refund selected items'}
            </button>
            <Link className="secondary-cta" to={`/orders/${receipt.order.id}/exchange`}>Exchange items instead →</Link>
            {refundError && <p role="alert" className="form-notice error">{refundError}</p>}
          </> : <p role="status">Every item on this receipt has been fully refunded.</p>}
        </div>}</>}
  </section>
}
