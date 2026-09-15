import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { completeLocalSale } from '../src/lib/checkout'
import { posDb } from '../src/lib/db'
import type { CartItem } from '../src/lib/pos-store'

const storeId = '90ca1d78-8027-4db8-8247-f4d8794b2680'
const productId = 'ff439cac-818c-43cc-924e-62f5cc049322'
const cart: CartItem[] = [{ productId, name: 'Test item', sku: 'TEST-001',
  unitPriceCents: 199, taxRateBps: 500, catalogVersion: 1, quantity: 2 }]

test('cash checkout commits the receipt, sale, payment, stock overlay and outbox together', async () => {
  await posDb.delete()
  await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC',
    currency: 'USD', catalog_version: 1 })
  const sale = await completeLocalSale(cart, storeId, 'cash', 500, null)
  assert.match(sale.receiptNumber, /^LOCAL-[0-9A-F]{8}-000001$/)
  const order = await posDb.orders.get(sale.operationId)
  assert.equal(order?.total_cents, 418)
  assert.equal((await posDb.order_items.where('order_id').equals(sale.operationId).toArray()).length, 1)
  assert.equal((await posDb.payments.where('order_id').equals(sale.operationId).first())?.change_cents, 82)
  assert.equal((await posDb.stock_adjustments.get([sale.operationId, productId]))?.delta, -2)
  const outbox = await posDb.outbox.where('operation_id').equals(sale.operationId).first()
  assert.equal(outbox?.status, 'pending')
  assert.equal(JSON.parse(outbox!.payload).operation_id, sale.operationId)
  assert.equal((await posDb.sync_metadata.get(`receipt_seq:${storeId}`))?.value, '1')
  await posDb.delete()
})

test('a failed outbox write rolls back the sale and receipt sequence', async () => {
  await posDb.delete()
  await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC',
    currency: 'USD', catalog_version: 1 })
  const originalAdd = posDb.outbox.add
  posDb.outbox.add = async () => { throw new Error('simulated storage failure') }
  try {
    await assert.rejects(completeLocalSale(cart, storeId, 'cash', 500, null), /simulated storage failure/)
  } finally { posDb.outbox.add = originalAdd }
  assert.equal(await posDb.orders.count(), 0)
  assert.equal(await posDb.order_items.count(), 0)
  assert.equal(await posDb.payments.count(), 0)
  assert.equal(await posDb.stock_adjustments.count(), 0)
  assert.equal(await posDb.outbox.count(), 0)
  assert.equal(await posDb.sync_metadata.get(`receipt_seq:${storeId}`), undefined)
  await posDb.delete()
})
