import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigationType, useParams } from 'react-router-dom'
import { liveQuery } from 'dexie'
import { readReceipt, syncLabel, type SavedReceipt } from './data'
import { ReceiptOutput } from './ReceiptOutput'
import { useReceiptStore } from './useReceiptStore'

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
  return <section className="receipt-page"><p className="kicker">SAVED LOCAL SALE</p><h1>Receipt.</h1>
    <div className="receipt-actions"><Link to={terminal ? '/pos/orders' : '/orders'}>← Back to orders</Link><Link to={terminal ? '/pos/register' : '/register'}>New sale →</Link></div>
    {failure ? <div role="alert"><p>{failure}</p><button type="button" onClick={() => { scope.retry(); setAttempt(value => value + 1) }}>Try again</button></div>
      : receipt === undefined ? <p role="status">Loading saved receipt…</p>
      : receipt === null ? <div role="status"><h2>Receipt not found</h2><p>This receipt is not saved for this store in this browser. Check Orders on the terminal that recorded the sale.</p></div>
      : <><p role="status">{fresh ? 'Sale saved in this browser. ' : ''}{syncLabel(receipt.order)}{receipt.order.failure_reason ? ` — ${receipt.order.failure_reason}` : ''}</p>
        <ReceiptOutput key={receipt.order.id} receipt={receipt} fresh={fresh} /></>}
  </section>
}
