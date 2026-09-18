import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigationType, useParams } from 'react-router-dom'
import { liveQuery } from 'dexie'
import { readReceipt, syncLabel, type SavedReceipt } from './data'
import { ReceiptOutput } from './ReceiptOutput'
import { useReceiptStore } from './useReceiptStore'
import { accessToken, configuredApiUrl } from '../lib/catalog'
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
  const [refundResult, setRefundResult] = useState<'refunded' | 'already' | null>(null)
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

  const submitRefund = async () => {
    if (!receipt || refunding) return
    if (!window.confirm(`Refund receipt ${receipt.order.receipt_number} for the full sale amount? This cannot be undone.`)) return
    setRefunding(true)
    setRefundError('')
    try {
      const token = await accessToken()
      const response = await fetch(`${configuredApiUrl()}/orders/${receipt.order.id}/refund`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ store_id: receipt.order.store_id }),
      })
      const data = (await response.json()) as { code?: string; message?: string }
      if (!response.ok) {
        if (data.code === 'refund_conflict') { setRefundResult('already'); return }
        throw new Error(data.message ?? `Server error (${response.status})`)
      }
      setRefundResult('refunded')
    } catch (reason) {
      setRefundError(reason instanceof Error ? reason.message : 'Could not refund this order.')
    } finally {
      setRefunding(false)
    }
  }

  return <section className="receipt-page"><p className="kicker">SAVED LOCAL SALE</p><h1>Receipt.</h1>
    <div className="receipt-actions"><Link to={terminal ? '/pos/orders' : '/orders'}>← Back to orders</Link><Link to={terminal ? '/pos/register' : '/register'}>New sale →</Link></div>
    {failure ? <div role="alert"><p>{failure}</p><button type="button" onClick={() => { scope.retry(); setAttempt(value => value + 1) }}>Try again</button></div>
      : receipt === undefined ? <p role="status">Loading saved receipt…</p>
      : receipt === null ? <div role="status"><h2>Receipt not found</h2><p>This receipt is not saved for this store in this browser. Check Orders on the terminal that recorded the sale.</p></div>
      : <><p role="status">{fresh ? 'Sale saved in this browser. ' : ''}{syncLabel(receipt.order)}{receipt.order.failure_reason ? ` — ${receipt.order.failure_reason}` : ''}</p>
        <ReceiptOutput key={receipt.order.id} receipt={receipt} fresh={fresh} />
        {canRefund && receipt.order.sync_status === 'synced' && <div className="refund-action">
          {refundResult === 'refunded' ? <p role="status">This order has been refunded.</p>
            : refundResult === 'already' ? <p role="status">This order was already refunded.</p>
            : <><button type="button" className="cta" onClick={() => void submitRefund()} disabled={refunding}>{refunding ? 'Refunding…' : 'Refund this receipt'}</button>
              {refundError && <p role="alert" className="form-notice error">{refundError}</p>}</>}
        </div>}</>}
  </section>
}
