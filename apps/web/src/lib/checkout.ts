import { calculateLine, sumLines, boundedInteger, MAX_CENTS } from '../../../../packages/domain/src/money'
import { posDb, type LocalOrder, type LocalOrderItem, type LocalPayment, type OutboxEntry } from './db'
import type { CartItem } from './pos-store'

export async function completeLocalSale(items: CartItem[], storeId: string, method: 'cash' | 'card', tenderedCents: number, reference: string | null, customerId: string | null = null) {
  if (!items.length) throw new Error('Add a product before checkout.')
  if (items.some(item => item.storeId !== storeId)) throw new Error('Cart contains a product from another store. Clear the cart and try again.')
  const config = await posDb.store_config.get(storeId)
  if (!config) throw new Error('Store catalog has not been downloaded to this browser.')
  const customer = customerId ? await posDb.customers.get(customerId) : null
  if (customerId && (!customer || customer.store_id !== storeId)) throw new Error('Selected customer does not belong to this store.')
  const lines = items.map(item => calculateLine(item.unitPriceCents, item.quantity, item.taxRateBps))
  const totals = sumLines(lines)
  boundedInteger(tenderedCents, 'Tender', 0, MAX_CENTS)
  if (tenderedCents < totals.totalCents) throw new Error('Amount received must cover the sale.')
  if (method === 'card' && tenderedCents !== totals.totalCents) throw new Error('Card amount must equal the sale total.')
  const operationId = crypto.randomUUID()
  const now = new Date().toISOString()
  let receiptNumber = ''
  await posDb.transaction('rw', [posDb.orders, posDb.order_items, posDb.payments,
    posDb.outbox, posDb.stock_adjustments, posDb.sync_metadata], async () => {
      const prefixRow = await posDb.sync_metadata.get(`receipt_prefix:${storeId}`)
      const prefix = prefixRow?.value ?? `LOCAL-${crypto.randomUUID().toUpperCase()}-`
      const sequenceKey = `receipt_seq:${storeId}`
      const sequence = Number((await posDb.sync_metadata.get(sequenceKey))?.value ?? '0') + 1
      if (!Number.isSafeInteger(sequence)) throw new Error('Receipt sequence is exhausted.')
      receiptNumber = `${prefix}${String(sequence).padStart(6, '0')}`
      const order: LocalOrder = { id: operationId, store_id: storeId, receipt_number: receiptNumber,
        subtotal_cents: totals.subtotalCents, tax_cents: totals.taxCents, total_cents: totals.totalCents,
        catalog_version: config.catalog_version, client_generated_at: now, sync_status: 'pending',
        currency: config.currency, store_name_snapshot: config.name, timezone_snapshot: config.timezone,
        accepted_checkpoint: null, failure_reason: customer && customer.sync_status !== 'synced' ? 'Waiting for customer upload.' : null,
        customer_id: customerId }
      const orderItems: LocalOrderItem[] = items.map((item, index) => ({ id: crypto.randomUUID(),
        order_id: operationId, product_id: item.productId, snapshot_name: item.name, snapshot_sku: item.sku,
        snapshot_price_cents: item.unitPriceCents, snapshot_tax_bps: item.taxRateBps, catalog_version: item.catalogVersion, quantity: item.quantity,
        subtotal_cents: lines[index].subtotalCents, tax_cents: lines[index].taxCents, total_cents: lines[index].totalCents }))
      const payment: LocalPayment = { id: crypto.randomUUID(), order_id: operationId, method,
        amount_cents: totals.totalCents, tendered_cents: tenderedCents,
        change_cents: method === 'cash' ? tenderedCents - totals.totalCents : 0, reference }
      const payload = { operation_id: operationId, order, items: orderItems, payment }
      const outbox: OutboxEntry = { store_id: storeId, operation_id: operationId, order_id: operationId, status: 'pending',
        failure_reason: null, failure_kind: null, reason_code: null, attempt_count: 0,
        lease_owner: null, lease_expires_at: null, accepted_checkpoint: null,
        next_attempt_at: now, created_at: now, payload: JSON.stringify(payload), entity_type: 'order',
        depends_on: customer?.creating_operation_id && customer.sync_status !== 'synced' ? [customer.creating_operation_id] : [] }
      await posDb.sync_metadata.put({ key: `receipt_prefix:${storeId}`, value: prefix })
      await posDb.sync_metadata.put({ key: sequenceKey, value: String(sequence) })
      await posDb.orders.add(order)
      await posDb.order_items.bulkAdd(orderItems)
      await posDb.payments.add(payment)
      for (const item of items) await posDb.stock_adjustments.add({ operation_id: operationId,
        product_id: item.productId, delta: -item.quantity, accepted_checkpoint: null })
      await posDb.outbox.add(outbox)
    })
  return { operationId, receiptNumber, totalCents: totals.totalCents }
}
