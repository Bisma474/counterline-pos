import { customerName, normalizedPhone } from '../../../../packages/domain/src/customer'
import { posDb, type LocalCustomer, type OutboxEntry } from './db'

export async function createLocalCustomer(storeId: string, rawName: string, rawPhone: string): Promise<LocalCustomer> {
  const name = customerName(rawName), phone = normalizedPhone(rawPhone)
  if (!storeId) throw new Error('Select a store before creating a customer.')
  if (phone) {
    const duplicate = await posDb.customers.where('store_id').equals(storeId)
      .and(customer => customer.phone_normalized === phone && customer.sync_status !== 'failed').first()
    if (duplicate) throw new Error('This phone number is already saved for another customer.')
  }
  const id = crypto.randomUUID(), operationId = crypto.randomUUID(), now = new Date().toISOString()
  const customer: LocalCustomer = { id, store_id: storeId, name, phone_normalized: phone,
    client_generated_at: now, creating_operation_id: operationId, sync_status: 'pending', failure_reason: null }
  const payload = { operation_id: operationId, entity_type: 'customer', schema_version: 1,
    customer: { id, store_id: storeId, name, phone_normalized: phone, client_generated_at: now } }
  const outbox: OutboxEntry = { store_id: storeId, operation_id: operationId, order_id: '', entity_type: 'customer',
    depends_on: [], status: 'pending', failure_reason: null, failure_kind: null, reason_code: null,
    attempt_count: 0, lease_owner: null, lease_expires_at: null, accepted_checkpoint: null,
    next_attempt_at: now, created_at: now, payload: JSON.stringify(payload) }
  await posDb.transaction('rw', posDb.customers, posDb.outbox, async () => {
    await posDb.customers.add(customer)
    await posDb.outbox.add(outbox)
  })
  return customer
}

// A query starting with '+' is a phone lookup (unambiguous, and normalizedPhone requires it);
// anything else — including an empty query, which lists every local customer — matches by name.
// A customer saved without a phone (it's optional) would otherwise never be findable again, since
// no phone search can ever match a null phone_normalized.
export async function searchLocalCustomers(storeId: string, rawQuery: string): Promise<LocalCustomer[]> {
  const all = await posDb.customers.where('store_id').equals(storeId).toArray()
  const trimmed = rawQuery.trim()
  if (trimmed.startsWith('+')) {
    const phone = normalizedPhone(rawQuery)
    if (!phone) return []
    return all.filter(customer => customer.phone_normalized?.startsWith(phone)).sort((a, b) => a.name.localeCompare(b.name))
  }
  const needle = trimmed.toLowerCase()
  return all.filter(customer => !needle || customer.name.toLowerCase().includes(needle)).sort((a, b) => a.name.localeCompare(b.name))
}
