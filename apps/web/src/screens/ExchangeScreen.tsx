/**
 * ExchangeScreen — Owner/Manager Backoffice (Phase 3: Exchange)
 *
 * Return specific item(s) from a past order and ring up replacement item(s) in one interaction,
 * with any price difference collected or refunded. Three in-page steps: pick what's being
 * returned (reusing the same "N of M refundable" picker ReceiptScreen's refund action uses), pick
 * replacement product(s) from the catalog, then tender payment for the difference.
 *
 * Online-only by design, matching InventoryScreen.tsx's manual adjustments/cycle counts — another
 * owner/manager-only backoffice action that calls the API directly rather than queuing through the
 * offline outbox (see completeLocalExchange in lib/checkout.ts for why).
 *
 * Deliberately its own small product picker rather than importing RegisterScreen's: that screen is
 * tightly coupled to the global cart store (Zustand), discounts, manager-approval and customer
 * selection — none of which apply here, and importing it would risk cross-contaminating an
 * in-progress register sale. This picker sources from the same Dexie tables, read-only.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { calculateDiscountedLine, formatCents, parseCents, sumDiscountedLines } from '../../../../packages/domain/src/money'
import { completeLocalExchange, type ExchangeReturnItem } from '../lib/checkout'
import { posDb, type LocalCategory, type LocalProduct, type LocalStock } from '../lib/db'
import { readReceipt, refundedQuantity, type SavedReceipt } from '../receipts/data'
import { useReceiptStore } from '../receipts/useReceiptStore'
import { requireSupabase } from '../lib/supabase'
import type { CartItem } from '../lib/pos-store'

type Step = 'return' | 'replace' | 'tender'

export function ExchangeScreen() {
  const { orderId = '' } = useParams()
  const navigate = useNavigate()
  const scope = useReceiptStore(false)

  const [receipt, setReceipt] = useState<SavedReceipt | null>()
  const [loadError, setLoadError] = useState('')
  const [access, setAccess] = useState<'checking' | 'granted' | 'denied'>('checking')

  useEffect(() => {
    let active = true
    if (!scope.storeId) return
    void (async () => {
      try {
        const savedReceipt = await readReceipt(scope.storeId, orderId)
        if (!active) return
        if (!savedReceipt) { setLoadError('This receipt is not saved for this store in this browser.'); setReceipt(null); return }
        setReceipt(savedReceipt)
        const client = requireSupabase()
        const { data: { user } } = await client.auth.getUser()
        if (!user) { if (active) setAccess('denied'); return }
        const { data } = await client.from('store_memberships').select('role').eq('user_id', user.id).eq('store_id', savedReceipt.order.store_id).eq('active', true).limit(1)
        if (active) setAccess(data?.[0]?.role === 'owner' || data?.[0]?.role === 'manager' ? 'granted' : 'denied')
      } catch (reason) {
        if (active) { setLoadError(reason instanceof Error ? reason.message : 'Unable to load this receipt.'); setAccess('denied') }
      }
    })()
    return () => { active = false }
  }, [orderId, scope.storeId])

  const [step, setStep] = useState<Step>('return')
  const [returnSelected, setReturnSelected] = useState<Record<string, number>>({})
  const [replacementCart, setReplacementCart] = useState<CartItem[]>([])
  const [method, setMethod] = useState<'cash' | 'card'>('cash')
  const [received, setReceived] = useState('')
  const [reference, setReference] = useState('')
  const [cardConfirmed, setCardConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refundableLines = useMemo(() => receipt?.items.map(item => ({ item, remaining: item.quantity - refundedQuantity(item.id, receipt.refundItems) })) ?? [], [receipt])
  const toggleReturnItem = (itemId: string, remaining: number) => {
    setReturnSelected(prev => {
      if (itemId in prev) { const { [itemId]: _removed, ...rest } = prev; return rest }
      return { ...prev, [itemId]: remaining }
    })
  }
  const setReturnQuantity = (itemId: string, remaining: number, raw: number) => {
    const quantity = Math.max(1, Math.min(remaining, Math.trunc(raw) || 1))
    setReturnSelected(prev => ({ ...prev, [itemId]: quantity }))
  }
  // Same proportional math the server uses (splitOrderItemRefundAmount) for the last chunk of a
  // line — approximate here for a live preview only; the server's response after submission is
  // always what actually gets recorded.
  const returnPreviewCents = useMemo(() => {
    if (!receipt) return 0
    return Object.entries(returnSelected).reduce((sum, [itemId, quantity]) => {
      const item = receipt.items.find(candidate => candidate.id === itemId)
      return item ? sum + Math.floor((item.total_cents * quantity) / item.quantity) : sum
    }, 0)
  }, [receipt, returnSelected])

  const [products, setProducts] = useState<LocalProduct[]>([])
  const [categories, setCategories] = useState<LocalCategory[]>([])
  const [stock, setStock] = useState<Record<string, number>>({})
  const [taxRates, setTaxRates] = useState<Record<string, number>>({})
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState('all')
  useEffect(() => {
    if (!receipt) return
    const storeId = receipt.order.store_id
    void (async () => {
      const [available, cats, rates, stocks, adjustments] = await Promise.all([
        posDb.products.where('store_id').equals(storeId).toArray(),
        posDb.categories.where('store_id').equals(storeId).toArray(),
        posDb.tax_rates.where('store_id').equals(storeId).toArray(),
        posDb.server_stock.toArray(), posDb.stock_adjustments.toArray(),
      ])
      setProducts(available.filter(product => product.active))
      setCategories(cats.filter(category => category.active))
      setTaxRates(Object.fromEntries(rates.filter(rate => rate.active).map(rate => [rate.id, rate.rate_bps])))
      const base = Object.fromEntries(stocks.map((row: LocalStock) => [row.product_id, row.current_stock]))
      for (const adjustment of adjustments) base[adjustment.product_id] = (base[adjustment.product_id] ?? 0) + adjustment.delta
      setStock(base)
    })()
  }, [receipt])
  const visibleProducts = useMemo(() => products.filter(product => {
    const term = query.trim().toLowerCase()
    const matches = !term || product.name.toLowerCase().includes(term) || product.sku.toLowerCase().includes(term)
    return matches && (categoryId === 'all' || product.category_id === categoryId)
  }), [products, query, categoryId])

  const addReplacementProduct = (product: LocalProduct) => {
    if (!receipt) return
    setReplacementCart(prev => {
      const existing = prev.find(item => item.productId === product.id)
      if (existing) return prev.map(item => item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item)
      return [...prev, { storeId: receipt.order.store_id, productId: product.id, name: product.name, sku: product.sku,
        unitPriceCents: product.unit_price_cents, taxRateBps: taxRates[product.tax_rate_id ?? ''] ?? 0,
        catalogVersion: receipt.order.catalog_version, quantity: 1, discount: null }]
    })
  }
  const changeReplacementQuantity = (productId: string, delta: number) => {
    setReplacementCart(prev => prev
      .map(item => item.productId === productId ? { ...item, quantity: item.quantity + delta } : item)
      .filter(item => item.quantity > 0))
  }

  const replacementLines = useMemo(() => replacementCart.map(item => calculateDiscountedLine(item.unitPriceCents, item.quantity, item.taxRateBps, null)), [replacementCart])
  const replacementTotals = useMemo(() => sumDiscountedLines(replacementLines), [replacementLines])
  const netPreviewCents = replacementTotals.totalCents - returnPreviewCents
  const currency = receipt?.order.currency ?? 'USD'

  let tenderedCents = 0
  let amountError = ''
  if (method === 'card') tenderedCents = replacementTotals.totalCents
  else if (received.trim()) { try { tenderedCents = parseCents(received) } catch (reason) { amountError = reason instanceof Error ? reason.message : 'Invalid cash amount.' } }
  const changeCents = tenderedCents >= replacementTotals.totalCents ? tenderedCents - replacementTotals.totalCents : 0
  const canSubmit = Object.keys(returnSelected).length > 0 && replacementCart.length > 0 && !amountError && !busy
    && (method === 'cash' ? tenderedCents >= replacementTotals.totalCents : cardConfirmed)

  const submit = async () => {
    if (!canSubmit || !receipt) return
    setBusy(true); setError('')
    try {
      const returnItems: ExchangeReturnItem[] = Object.entries(returnSelected).map(([orderItemId, quantity]) => ({ orderItemId, quantity }))
      const result = await completeLocalExchange(receipt.order.id, returnItems, replacementCart, receipt.order.store_id, method, tenderedCents, reference.trim() || null)
      navigate(`/orders/${encodeURIComponent(result.newOrderId)}`, { replace: true, state: { committedOrderId: result.newOrderId } })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The exchange could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  if (scope.error) return <section className="receipt-page"><div role="alert"><p>{scope.error}</p></div></section>
  if (access === 'checking' || receipt === undefined) return <section className="receipt-page"><p role="status">Loading…</p></section>
  if (access === 'denied') return <section className="receipt-page"><div role="alert"><h2>Not available</h2><p>Exchanges are available to store owners and managers only.</p></div></section>
  if (loadError || receipt === null) return <section className="receipt-page"><div role="alert"><h2>Receipt not found</h2><p>{loadError}</p></div></section>

  return <section className="receipt-page exchange-page">
    <p className="kicker">EXCHANGE</p><h1>Exchange receipt {receipt.order.receipt_number}.</h1>
    <div className="receipt-actions"><Link to={`/orders/${orderId}`}>← Back to receipt</Link></div>

    {step === 'return' && <div className="refund-action">
      <h3>1. Select items to return</h3>
      <div className="refund-item-picker">
        {refundableLines.map(({ item, remaining }) => remaining <= 0
          ? <p key={item.id} className="refund-item-exhausted">{item.snapshot_name} — fully refunded</p>
          : <div key={item.id} className="refund-item-row">
              <label>
                <input type="checkbox" checked={item.id in returnSelected} onChange={() => toggleReturnItem(item.id, remaining)} />
                {item.snapshot_name} ({remaining} of {item.quantity} available)
              </label>
              {item.id in returnSelected && <input type="number" min={1} max={remaining} value={returnSelected[item.id]}
                onChange={event => setReturnQuantity(item.id, remaining, Number(event.target.value))} aria-label={`Quantity of ${item.snapshot_name} to return`} />}
            </div>)}
      </div>
      <button type="button" className="cta" disabled={!Object.keys(returnSelected).length} onClick={() => setStep('replace')}>Continue to replacement →</button>
    </div>}

    {step === 'replace' && <div className="refund-action">
      <h3>2. Pick replacement item(s)</h3>
      <div className="catalog-tools"><label className="search" htmlFor="exchange-search"><span aria-hidden="true">⌕</span>
        <input id="exchange-search" type="search" placeholder="Search name or SKU" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <div className="catalog-filter-bar" aria-label="Product categories"><strong>Browse</strong><div className="categories">
        <button type="button" className={categoryId === 'all' ? 'active' : ''} onClick={() => setCategoryId('all')}>All products</button>
        {categories.map(category => <button type="button" key={category.id} className={categoryId === category.id ? 'active' : ''} onClick={() => setCategoryId(category.id)}>{category.name}</button>)}
      </div></div>
      <div className="catalog-grid">{visibleProducts.map(product => <button type="button" className="catalog-card" key={product.id} onClick={() => addReplacementProduct(product)}>
        <strong>{product.name}</strong><span>{formatCents(product.unit_price_cents, currency)}</span><small>{stock[product.id] ?? 0} in stock · {product.sku}</small>
      </button>)}</div>
      {!replacementCart.length && <p className="empty-cart">Add at least one replacement product.</p>}
      {replacementCart.map((item, index) => <div className="cart-line" key={item.productId}>
        <span><strong>{item.name}</strong><small>{formatCents(item.unitPriceCents, currency)} each</small></span>
        <div className="quantity"><button type="button" aria-label={`Remove one ${item.name}`} onClick={() => changeReplacementQuantity(item.productId, -1)}>−</button>
          <b>{item.quantity}</b><button type="button" aria-label={`Add one ${item.name}`} onClick={() => changeReplacementQuantity(item.productId, 1)}>+</button></div>
        <b>{formatCents(replacementLines[index]?.totalCents ?? 0, currency)}</b>
      </div>)}
      <div className="totals"><span>Replacement total <b>{formatCents(replacementTotals.totalCents, currency)}</b></span>
        <span>Returned value (estimated) <b>−{formatCents(returnPreviewCents, currency)}</b></span>
        <strong>{netPreviewCents >= 0 ? 'Customer owes' : 'Refund to customer'} <b>{formatCents(Math.abs(netPreviewCents), currency)}</b></strong></div>
      <div className="receipt-actions"><button type="button" className="secondary-cta" onClick={() => setStep('return')}>← Back</button>
        <button type="button" className="cta" disabled={!replacementCart.length} onClick={() => setStep('tender')}>Continue to payment →</button></div>
    </div>}

    {step === 'tender' && <div className="refund-action">
      <h3>3. Collect payment</h3>
      <p className="screen-note">{netPreviewCents >= 0 ? `Customer owes ${formatCents(netPreviewCents, currency)} more.` : `Refund ${formatCents(-netPreviewCents, currency)} to the customer.`} (Estimated — the exact figure is confirmed after submitting.)</p>
      <fieldset className="methods"><legend>Replacement payment method</legend>
        <button type="button" className={method === 'cash' ? 'selected' : ''} onClick={() => setMethod('cash')}>Cash</button>
        <button type="button" className={method === 'card' ? 'selected' : ''} onClick={() => setMethod('card')}>Card (external)</button>
      </fieldset>
      {method === 'cash' ? <label>Amount received for replacement<input type="text" inputMode="decimal" value={received}
        onChange={event => setReceived(event.target.value)} placeholder="0.00" /><span className="quick-tender">
          <button type="button" onClick={() => setReceived((replacementTotals.totalCents / 100).toFixed(2))}>Exact amount</button>
        </span></label> : <>
        <label>External payment reference (optional)<input type="text" maxLength={120} value={reference} onChange={event => setReference(event.target.value)} /></label>
        <label className="card-confirm"><input type="checkbox" checked={cardConfirmed} onChange={event => setCardConfirmed(event.target.checked)} /> I confirm the external card payment was approved.</label>
      </>}
      {method === 'cash' && <p className="screen-note">Change due: {formatCents(changeCents, currency)}</p>}
      {amountError && <p className="form-notice error" role="alert">{amountError}</p>}
      {error && <p className="form-notice error" role="alert">{error}</p>}
      <div className="receipt-actions"><button type="button" className="secondary-cta" onClick={() => setStep('replace')} disabled={busy}>← Back</button>
        <button type="button" className="cta" disabled={!canSubmit} onClick={() => void submit()}>{busy ? 'Completing exchange…' : 'Complete exchange'}</button></div>
    </div>}
  </section>
}
