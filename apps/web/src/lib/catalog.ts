import { posDb, type LocalProduct } from './db'
import { requireSupabase } from './supabase'

const apiUrl = import.meta.env.VITE_API_URL as string | undefined
export function configuredApiUrl(): string {
  if (!apiUrl) throw new Error('Catalog API is not configured. Set VITE_API_URL in apps/web/.env.local.')
  return apiUrl.replace(/\/$/, '')
}
export async function accessToken(): Promise<string> {
  const { data, error } = await requireSupabase().auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Sign in before syncing this store.')
  return data.session.access_token
}
export async function activeStoreId(): Promise<string> {
  const client = requireSupabase()
  const { data: userResult, error: userError } = await client.auth.getUser()
  if (userError || !userResult.user) throw new Error('Sign in to load a store.')
  const { data, error } = await client.from('store_memberships').select('store_id').eq('user_id', userResult.user.id).eq('active', true).limit(1)
  if (error) throw error
  if (!data?.[0]) throw new Error('No active store membership was found.')
  return data[0].store_id as string
}

type Snapshot = {
  store: { id: string; name: string; timezone: string; currency: string }
  catalog_version: number
  checkpoint: string
  categories: { id: string; store_id: string; name: string; active: boolean }[]
  tax_rates: { id: string; store_id: string; name: string; rate_bps: number; active: boolean }[]
  products: (Omit<LocalProduct, 'unit_price_cents' | 'revision'> & { unit_price_cents: string; revision: string })[]
  stock: { product_id: string; current_stock: number; updated_at: string }[]
}

export async function loadCatalog(storeId: string): Promise<'updated' | 'cached'> {
  if (!navigator.onLine) return 'cached'
  const response = await fetch(`${configuredApiUrl()}/catalog/snapshot?store_id=${encodeURIComponent(storeId)}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  })
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(`${failure?.message ?? 'Catalog could not be loaded.'} (${response.status})`)
  }
  const snapshot = await response.json() as Snapshot
  if (snapshot.store?.id !== storeId) throw new Error('Catalog response belongs to another store.')
  if (!/^\d+$/.test(snapshot.checkpoint)) throw new Error('Catalog checkpoint is invalid.')
  const products = snapshot.products.map(product => {
    const price = Number(product.unit_price_cents)
    const revision = Number(product.revision)
    if (!Number.isSafeInteger(price) || price < 0 || price > 1_000_000_000 || !Number.isSafeInteger(revision)) {
      throw new Error('Catalog contains an invalid price or revision.')
    }
    return { ...product, unit_price_cents: price, revision }
  })
  await posDb.transaction('rw', [posDb.store_config, posDb.categories, posDb.tax_rates,
    posDb.products, posDb.server_stock, posDb.stock_adjustments, posDb.outbox], async () => {
      const unresolved = await posDb.outbox.where('status').anyOf('pending', 'failed').toArray()
      if (unresolved.some(entry => entry.status === 'pending' || entry.failure_kind !== 'validation')) {
        throw new Error('Pending sync outcomes must be resolved before refreshing stock.')
      }
      await posDb.store_config.put({ id: storeId, store_id: storeId, name: snapshot.store.name,
        timezone: snapshot.store.timezone, currency: snapshot.store.currency, catalog_version: snapshot.catalog_version })
      await posDb.categories.where('store_id').equals(storeId).delete()
      await posDb.tax_rates.where('store_id').equals(storeId).delete()
      await posDb.products.where('store_id').equals(storeId).delete()
      await posDb.categories.bulkPut(snapshot.categories.map(category => ({ ...category, parent_id: null })))
      await posDb.tax_rates.bulkPut(snapshot.tax_rates)
      await posDb.products.bulkPut(products)
      await posDb.server_stock.bulkPut(snapshot.stock)
      const adjustments = await posDb.stock_adjustments.toArray()
      for (const adjustment of adjustments) {
        if (adjustment.accepted_checkpoint && BigInt(adjustment.accepted_checkpoint) <= BigInt(snapshot.checkpoint)) {
          await posDb.stock_adjustments.delete([adjustment.operation_id, adjustment.product_id])
        }
      }
    })
  return 'updated'
}
