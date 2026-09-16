import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatCents } from '../../../../packages/domain/src/money'
import { activeStoreId, loadCatalog } from '../lib/catalog'
import { posDb, type LocalCategory, type LocalProduct, type LocalStock } from '../lib/db'
import { pushPendingOrders } from '../lib/order-sync'
import { usePosStore } from '../lib/pos-store'
import { currentAccess } from '../terminal-auth/cache'
import { requireSupabase } from '../lib/supabase'
import { CustomerSelector } from './CustomerScreen'
import { liveQuery } from 'dexie'

export function RegisterScreen({ terminal = false }: { terminal?: boolean }) {
  const [products, setProducts] = useState<LocalProduct[]>([])
  const [categories, setCategories] = useState<LocalCategory[]>([])
  const [stock, setStock] = useState<Record<string, number>>({})
  const [taxRates, setTaxRates] = useState<Record<string, number>>({})
  const [currency, setCurrency] = useState('USD')
  const [catalogVersion, setCatalogVersion] = useState(1)
  const [storeId, setStoreId] = useState('')
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [customerOpen, setCustomerOpen] = useState(false)
  const [customerSyncWarning, setCustomerSyncWarning] = useState('')
  const [customerAuthorized, setCustomerAuthorized] = useState(terminal)
  const cart = usePosStore(state => state.items)
  const addItem = usePosStore(state => state.addItem)
  const increment = usePosStore(state => state.incrementItem)
  const decrement = usePosStore(state => state.decrementItem)
  const remove = usePosStore(state => state.removeItem)
  const clear = usePosStore(state => state.clearCart)
  const selectedCustomer = usePosStore(state => state.selectedCustomer)
  const selectCustomer = usePosStore(state => state.selectCustomer)
  const setStoreContext = usePosStore(state => state.setStoreContext)
  const setCatalogStatus = usePosStore(state => state.setCatalogStatus)
  const totals = usePosStore(state => state.totals)
  useEffect(() => {
    if (!storeId) return
    const subscription = liveQuery(() => posDb.outbox.where('store_id').equals(storeId).toArray()).subscribe(entries => {
      const waiting = entries.filter(entry => entry.entity_type === 'order' && (entry.depends_on?.length ?? 0) > 0 && entry.status !== 'synced')
      const blocked = waiting.find(entry => entry.failure_kind === 'dependency')
      setCustomerSyncWarning(waiting.length ? `${waiting.length} completed sale${waiting.length === 1 ? '' : 's'} waiting for customer sync. ${blocked?.failure_reason ?? 'Customer upload will run before linked sales.'}` : '')
    })
    return () => subscription.unsubscribe()
  }, [storeId])
  useEffect(() => {
    const id = selectedCustomer?.id
    if (!id) return
    const subscription = liveQuery(() => posDb.customers.get(id)).subscribe(customer => {
      if (customer && usePosStore.getState().selectedCustomer?.id === id && usePosStore.getState().selectedCustomer?.sync_status !== customer.sync_status) selectCustomer(customer)
    })
    return () => subscription.unsubscribe()
  }, [selectedCustomer?.id, selectCustomer])
  useEffect(() => {
    if (!storeId) return
    let active = true
    const sync = () => { if (active && navigator.onLine) void pushPendingOrders(storeId, terminal).catch(() => undefined) }
    window.addEventListener('online', sync)
    const interval = window.setInterval(sync, 15_000)
    return () => { active = false; window.removeEventListener('online', sync); window.clearInterval(interval) }
  }, [storeId, terminal])

  useEffect(() => {
    let active = true
    async function boot() {
      try {
        const terminalAccess = terminal ? await currentAccess() : undefined
        const id = terminal ? terminalAccess?.cache.device.store_id : await activeStoreId()
        if (!id || (terminal && !terminalAccess?.policy.valid)) throw new Error('Unlock this terminal before opening the register.')
        if (!active) return
        setStoreId(id)
        setStoreContext(id, '')
        if (!terminal && navigator.onLine) {
          try {
            const client = requireSupabase()
            const { data: { user } } = await client.auth.getUser()
            if (user) {
              const { data: memberships } = await client.from('store_memberships').select('role').eq('user_id', user.id).eq('store_id', id).eq('active', true).limit(1)
              const allowed = memberships?.[0]?.role === 'owner' || memberships?.[0]?.role === 'manager'
              if (active) { setCustomerAuthorized(allowed); if (!allowed) selectCustomer(null) }
            }
          } catch { if (active) setCustomerAuthorized(false) }
        }
        if (terminal) await posDb.sync_metadata.put({ key: `receipt_prefix:${id}`, value: terminalAccess!.cache.device.receipt_prefix })
        const cached = await posDb.store_config.get(id)
        if (cached) setStoreContext(id, cached.name)
        const refresh = async () => {
          const [config, available, cats, rates, stocks, adjustments] = await Promise.all([
            posDb.store_config.get(id), posDb.products.where('store_id').equals(id).toArray(),
            posDb.categories.where('store_id').equals(id).toArray(), posDb.tax_rates.where('store_id').equals(id).toArray(),
            posDb.server_stock.toArray(), posDb.stock_adjustments.toArray(),
          ])
          if (!active) return
          if (config) { setCurrency(config.currency); setCatalogVersion(config.catalog_version); setStoreContext(id, config.name) }
          setProducts(available.filter(product => product.active))
          setCategories(cats.filter(category => category.active))
          setTaxRates(Object.fromEntries(rates.filter(rate => rate.active).map(rate => [rate.id, rate.rate_bps])))
          const base = Object.fromEntries(stocks.map((row: LocalStock) => [row.product_id, row.current_stock]))
          for (const adjustment of adjustments) base[adjustment.product_id] = (base[adjustment.product_id] ?? 0) + adjustment.delta
          setStock(base)
        }
        await refresh()
        try {
          await pushPendingOrders(id, terminal)
          const result = await loadCatalog(id, terminal)
          if (result === 'updated') await refresh()
          if (!await posDb.products.where('store_id').equals(id).count()) throw new Error('Connect to load this store’s products.')
          setCatalogStatus('ready')
        }
        catch (reason) {
          setCatalogStatus('unavailable')
          const message = reason instanceof Error ? reason.message : 'Catalog service is unavailable.'
          if (await posDb.products.where('store_id').equals(id).count()) setNotice(`Using saved catalog. ${message}`)
          else setError(`No catalog saved for this store. ${message}`)
        }
      } catch (reason) { if (active) { setCatalogStatus('unavailable'); setError(reason instanceof Error ? reason.message : 'Unable to open the register.') } }
      finally { if (active) setLoading(false) }
    }
    void boot()
    return () => { active = false }
  }, [setStoreContext, setCatalogStatus, terminal])

  const visible = useMemo(() => products.filter(product => {
    const term = query.trim().toLowerCase()
    const matches = !term || product.name.toLowerCase().includes(term) || product.sku.toLowerCase().includes(term) ||
      product.barcode?.toLowerCase().includes(term)
    return matches && (categoryId === 'all' || product.category_id === categoryId)
  }), [products, query, categoryId])
  let total = { subtotalCents: 0, taxCents: 0, totalCents: 0 }
  let cartError = ''
  try { total = totals() } catch (reason) { cartError = reason instanceof Error ? reason.message : 'Cart amount is invalid.' }

  return <section className="register-page" aria-label="Register">
    <div className="catalog">
      <div className="catalog-tools"><label className="search" htmlFor="catalog-search"><span aria-hidden="true">⌕</span>
        <input id="catalog-search" type="search" placeholder="Search name, SKU or barcode" value={query} onChange={event => setQuery(event.target.value)} /></label>
      </div><div className="catalog-filter-bar" aria-label="Product categories"><strong>Browse</strong><div className="categories"><button type="button" className={categoryId === 'all' ? 'active' : ''} onClick={() => setCategoryId('all')}>All products</button>
        {categories.map(category => <button type="button" key={category.id} className={categoryId === category.id ? 'active' : ''} onClick={() => setCategoryId(category.id)}>{category.name}</button>)}</div></div>
      {loading && <p className="screen-note" role="status">Loading saved catalog…</p>}
      {error && <p className="form-notice error" role="alert">{error}</p>}
      {notice && <p className="screen-note" role="status">{notice}</p>}
      {!loading && !error && !visible.length && <p className="screen-note">{products.length ? 'No products match your search.' : 'No catalog saved. Connect to load this store’s products.'}</p>}
      <div className="catalog-grid">{visible.map(product => <button type="button" className="catalog-card" key={product.id}
        disabled={Boolean(product.tax_rate_id && taxRates[product.tax_rate_id] === undefined)}
        onClick={() => addItem({ storeId, productId: product.id, name: product.name, sku: product.sku,
          unitPriceCents: product.unit_price_cents, taxRateBps: taxRates[product.tax_rate_id ?? ''] ?? 0,
          catalogVersion })}>
        <div className="product-art" aria-hidden="true" /><strong>{product.name}</strong>
        <span>{formatCents(product.unit_price_cents, currency)}</span><small>{stock[product.id] ?? 0} in stock · {product.sku}</small>
      </button>)}</div>
    </div>
    <aside className="sale-cart"><div className="cart-title"><h2>Current Sale</h2><button className="text-action" type="button" onClick={clear} disabled={!cart.length}>Clear cart</button></div>
      <div className="crm-cart-customer">{selectedCustomer && customerAuthorized ? <><strong>{selectedCustomer.name}</strong><small>{selectedCustomer.phone_normalized ? `+${selectedCustomer.phone_normalized}` : 'No phone'} · {selectedCustomer.sync_status === 'synced' ? 'Saved' : 'Pending sync'}</small><div className="crm-cart-customer-actions"><button type="button" className="text-action" onClick={() => setCustomerOpen(true)}>Change customer</button><button type="button" className="text-action" onClick={() => selectCustomer(null)}>Remove</button></div></> : <><button type="button" className="text-action" disabled={!storeId || !customerAuthorized} onClick={() => setCustomerOpen(true)}>Add customer</button>{storeId && !customerAuthorized && <small>Customer access requires validated management membership.</small>}</>}</div>
      {customerSyncWarning && <p className="crm-sync-note" role="status">{customerSyncWarning}</p>}
      {!cart.length && <p className="empty-cart">Add a product to start a sale.</p>}
      {cart.map(item => <div className="cart-line" key={item.productId}><span><strong>{item.name}</strong><small>{formatCents(item.unitPriceCents, currency)} each</small></span>
        <div className="quantity"><button type="button" aria-label={`Remove one ${item.name}`} onClick={() => decrement(item.productId)}>−</button><b>{item.quantity}</b>
          <button type="button" aria-label={`Add one ${item.name}`} onClick={() => increment(item.productId)}>+</button></div>
        <button type="button" aria-label={`Remove ${item.name}`} onClick={() => remove(item.productId)}>×</button></div>)}
      <div className="totals"><span>Subtotal <b>{formatCents(total.subtotalCents, currency)}</b></span><span>Tax <b>{formatCents(total.taxCents, currency)}</b></span>
        <strong>Total <b>{formatCents(total.totalCents, currency)}</b></strong></div>
      {cartError && <p className="form-notice error" role="alert">{cartError}</p>}
      <Link className={`cta ${!cart.length || cartError || !storeId ? 'cta-disabled' : ''}`} to={cart.length && !cartError && storeId ? terminal ? '/pos/payment' : '/payment' : terminal ? '/pos/register' : '/register'}
        aria-disabled={!cart.length || Boolean(cartError) || !storeId}>Proceed to payment <b aria-hidden="true">→</b></Link>
    </aside>
    {customerOpen && storeId && customerAuthorized && <CustomerSelector storeId={storeId} terminal={terminal} onClose={() => setCustomerOpen(false)} />}
  </section>
}
