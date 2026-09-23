import { normalizedPhone } from '../../../../packages/domain/src/customer'
import { accessToken, configuredApiUrl } from './catalog'
import { posDb, type LocalCustomer } from './db'
export { createLocalCustomer, searchLocalCustomers } from './customer-local'

type SearchResult = { customers: Array<{ id: string; store_id: string; name: string; phone_normalized: string | null }>; next_cursor: string | null }
// A query starting with '+' searches by phone (exact prefix); anything else — including empty,
// which browses the store's whole customer list — searches by name substring server-side.
export async function searchServerCustomers(storeId: string, rawQuery: string, terminal: boolean, cursor: string | null = null): Promise<SearchResult> {
  const trimmed = rawQuery.trim()
  const query = new URLSearchParams({ limit: '20' })
  if (trimmed.startsWith('+')) {
    const phone = normalizedPhone(rawQuery)
    if (!phone) throw new Error('Enter a phone number with its country code.')
    query.set('phone', `+${phone}`)
  } else if (trimmed) {
    query.set('q', trimmed)
  }
  if (!terminal) query.set('store_id', storeId)
  if (cursor) query.set('cursor', cursor)
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/customers' : '/customers'}?${query}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as SearchResult & { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Customer search failed (${response.status}).`)
  await posDb.transaction('rw', posDb.customers, async () => {
    for (const result of body.customers) {
      if (result.store_id !== storeId) continue
      const existing = await posDb.customers.get(result.id)
      if (existing && existing.sync_status !== 'synced') continue
      await posDb.customers.put({ id: result.id, store_id: storeId, name: result.name,
        phone_normalized: result.phone_normalized, client_generated_at: existing?.client_generated_at ?? new Date().toISOString(),
        creating_operation_id: existing?.creating_operation_id ?? null, sync_status: 'synced', failure_reason: null })
    }
  })
  return body
}
