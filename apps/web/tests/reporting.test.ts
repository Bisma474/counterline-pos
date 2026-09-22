import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalOrder, LocalOrderItem, LocalPayment, LocalRefund, LocalRefundItem, OutboxEntry } from '../src/lib/db'
import { calculateLocalSalesReport, calculateCashierShift, calendarDay } from '../src/lib/reporting'

const order = (overrides: Partial<LocalOrder> & Pick<LocalOrder, 'id' | 'store_id' | 'client_generated_at'>): LocalOrder => ({
  receipt_number: `R-${overrides.id}`, subtotal_cents: 1000, tax_cents: 100, total_cents: 1100,
  catalog_version: 1, sync_status: 'synced', currency: 'USD', store_name_snapshot: 'Store',
  timezone_snapshot: 'Asia/Karachi', accepted_checkpoint: null, failure_reason: null, ...overrides,
})
const item = (orderId: string, quantity: number): LocalOrderItem => ({ id: `item-${orderId}`, order_id: orderId,
  product_id: 'product', snapshot_name: 'Item', snapshot_sku: 'SKU', snapshot_price_cents: 1000,
  snapshot_tax_bps: 1000, catalog_version: 1, quantity, subtotal_cents: 1000, tax_cents: 100, total_cents: 1100 })
const payment = (orderId: string, method: 'cash' | 'card', amount: number, tendered = amount, change = 0): LocalPayment => ({
  id: `payment-${orderId}`, order_id: orderId, method, amount_cents: amount, tendered_cents: tendered, change_cents: change, reference: null,
})
const outbox = (orderId: string, storeId: string, failureKind: OutboxEntry['failure_kind'] = null): OutboxEntry => ({
  store_id: storeId, operation_id: `op-${orderId}`, order_id: orderId, status: failureKind === 'validation' ? 'failed' : 'pending',
  failure_reason: null, failure_kind: failureKind, reason_code: null, attempt_count: 0, lease_owner: null,
  lease_expires_at: null, accepted_checkpoint: null, next_attempt_at: new Date(0).toISOString(), created_at: new Date(0).toISOString(), payload: '{}',
})

test('uses the saved store timezone for calendar-day boundaries', () => {
  assert.equal(calendarDay('2026-09-15T18:59:59.000Z', 'Asia/Karachi'), '2026-09-15')
  assert.equal(calendarDay('2026-09-15T19:00:00.000Z', 'Asia/Karachi'), '2026-09-16')
})

test('reconciles local sales, excludes cash change, and keeps unresolved sales in totals', () => {
  const orders = [
    order({ id: 'cash', store_id: 'store-a', client_generated_at: '2026-09-15T19:30:00.000Z', subtotal_cents: 1000, discount_cents: 100, tax_cents: 90, total_cents: 990, sync_status: 'pending' }),
    order({ id: 'card', store_id: 'store-a', client_generated_at: '2026-09-16T10:00:00.000Z', subtotal_cents: 2000, tax_cents: 200, total_cents: 2200, sync_status: 'failed' }),
    order({ id: 'other-store', store_id: 'store-b', client_generated_at: '2026-09-16T10:00:00.000Z' }),
  ]
  const report = calculateLocalSalesReport('store-a', '2026-09-16', 'Asia/Karachi', {
    orders, items: [item('cash', 2), item('card', 3), item('other-store', 50)],
    payments: [payment('cash', 'cash', 990, 1500, 510), payment('card', 'card', 2200), payment('other-store', 'cash', 1100)],
    outbox: [outbox('cash', 'store-a'), outbox('card', 'store-a', 'validation')],
  })
  assert.deepEqual(report, {
    grossSalesCents: 3000, discountCents: 100, netSalesCents: 2900, taxCents: 290,
    cashTakingsCents: 990, cardTakingsCents: 2200, recordedTotalCents: 3190,
    completedOrderCount: 2, averageSaleCents: 1595, itemsSold: 5,
    pendingCount: 1, pendingAmountCents: 990, rejectedCount: 1, rejectedAmountCents: 2200,
    refundedCount: 0, refundedAmountCents: 0,
  })
})

test('a refunded sale remains in gross activity while reducing net totals and takings', () => {
  const orders = [
    order({ id: 'kept', store_id: 'store-a', client_generated_at: '2026-09-16T10:00:00.000Z', subtotal_cents: 1000, tax_cents: 100, total_cents: 1100 }),
    order({ id: 'refunded', store_id: 'store-a', client_generated_at: '2026-09-16T11:00:00.000Z', subtotal_cents: 2000, tax_cents: 200, total_cents: 2200,
      refunded_at: '2026-09-16T12:00:00.000Z', refunded_amount_cents: 2200 }),
  ]
  const report = calculateLocalSalesReport('store-a', '2026-09-16', 'Asia/Karachi', {
    orders, items: [item('kept', 1), item('refunded', 3)],
    payments: [payment('kept', 'cash', 1100), payment('refunded', 'card', 2200)],
    outbox: [],
  })
  assert.equal(report.completedOrderCount, 2)
  assert.equal(report.recordedTotalCents, 1100)
  assert.equal(report.grossSalesCents, 3000)
  assert.equal(report.netSalesCents, 1000)
  assert.equal(report.taxCents, 100)
  assert.equal(report.cardTakingsCents, 0)
  assert.equal(report.itemsSold, 4, 'gross units preserve the original sale')
  assert.equal(report.averageSaleCents, 1650)
  assert.equal(report.refundedCount, 1)
  assert.equal(report.refundedAmountCents, 2200)
  const shift = calculateCashierShift(orders, [payment('kept', 'cash', 1100), payment('refunded', 'card', 2200)], 'store-a', '2026-09-16', 'Asia/Karachi')
  assert.equal(shift.orderCount, 2)
  assert.equal(shift.salesCents, 1100)
  assert.equal(shift.cardCents, 0)
  const nextDay = calculateLocalSalesReport('store-a', '2026-09-17', 'Asia/Karachi', {
    orders: orders.map(row => row.id === 'refunded' ? { ...row, refunded_at: '2026-09-17T12:00:00.000Z' } : row),
    items: [item('kept', 1), item('refunded', 3)],
    payments: [payment('kept', 'cash', 1100), payment('refunded', 'card', 2200)], outbox: [],
  })
  assert.equal(nextDay.grossSalesCents, 0)
  assert.equal(nextDay.recordedTotalCents, -2200)
  assert.equal(nextDay.cardTakingsCents, -2200)
  assert.equal(nextDay.refundedCount, 1)
})

test('a precise, per-line partial refund only reduces net sales/tax by the refunded share, and buckets by the refund event\'s own day', () => {
  // A 3-unit line at 500/unit + 5% tax: subtotal 1500, tax 75, total 1575. Sold on the 16th.
  const orders = [order({ id: 'partial', store_id: 'store-a', client_generated_at: '2026-09-16T10:00:00.000Z', subtotal_cents: 1500, tax_cents: 75, total_cents: 1575 })]
  const items: LocalOrderItem[] = [{ id: 'item-partial', order_id: 'partial', product_id: 'product', snapshot_name: 'Item', snapshot_sku: 'SKU',
    snapshot_price_cents: 500, snapshot_tax_bps: 500, catalog_version: 1, quantity: 3, subtotal_cents: 1500, discount_applied_cents: 0, taxable_cents: 1500, tax_cents: 75, total_cents: 1575 }]
  const payments = [payment('partial', 'card', 1575)]

  // Refund 1 of 3 units on the 16th (same day as the sale): 1/3 of 1500 = 500, 1/3 of 75 = 25.
  const refund1: LocalRefund = { id: 'refund-1', store_id: 'store-a', order_id: 'partial', amount_cents: 525, reason: null, refunded_by: 'owner', created_at: '2026-09-16T11:00:00.000Z' }
  const refundItem1: LocalRefundItem = { id: 'ri-1', refund_id: 'refund-1', order_item_id: 'item-partial', product_id: 'product', quantity: 1, amount_cents: 525 }
  // Refund the remaining 2 units the NEXT day: exact remainder 1575-525=1050.
  const refund2: LocalRefund = { id: 'refund-2', store_id: 'store-a', order_id: 'partial', amount_cents: 1050, reason: null, refunded_by: 'owner', created_at: '2026-09-17T09:00:00.000Z' }
  const refundItem2: LocalRefundItem = { id: 'ri-2', refund_id: 'refund-2', order_item_id: 'item-partial', product_id: 'product', quantity: 2, amount_cents: 1050 }

  const saleDay = calculateLocalSalesReport('store-a', '2026-09-16', 'Asia/Karachi', {
    orders, items, payments, outbox: [], refunds: [refund1, refund2], refundItems: [refundItem1, refundItem2],
  })
  assert.equal(saleDay.grossSalesCents, 1500, 'the sale itself is still fully recorded on its own day')
  assert.equal(saleDay.refundedCount, 1, 'only refund1 falls on the 16th')
  assert.equal(saleDay.refundedAmountCents, 525)
  assert.equal(saleDay.netSalesCents, 1500 - 500, 'reduced only by the 1-unit share, not the whole 1500 line')
  assert.equal(saleDay.taxCents, 75 - 25)
  assert.equal(saleDay.cardTakingsCents, 1575 - 525)

  const refundDay = calculateLocalSalesReport('store-a', '2026-09-17', 'Asia/Karachi', {
    orders, items, payments, outbox: [], refunds: [refund1, refund2], refundItems: [refundItem1, refundItem2],
  })
  assert.equal(refundDay.grossSalesCents, 0, 'no sale happened on the 17th')
  assert.equal(refundDay.refundedCount, 1, 'only refund2 falls on the 17th')
  assert.equal(refundDay.refundedAmountCents, 1050)
  assert.equal(refundDay.netSalesCents, -1000, 'the remaining 2/3 share, as a negative (today has only a refund, no sale)')
  assert.equal(refundDay.taxCents, -50)
})

test('an order refunded before this feature existed (refunded_at but no local refund rows) still falls back to the legacy whole-order path, alongside a real precise-path refund on another order the same day', () => {
  const orders = [
    order({ id: 'legacy-mixed', store_id: 'store-a', client_generated_at: '2026-09-16T10:00:00.000Z', subtotal_cents: 1000, tax_cents: 100, total_cents: 1100,
      refunded_at: '2026-09-16T12:00:00.000Z', refunded_amount_cents: 1100 }),
    order({ id: 'precise-mixed', store_id: 'store-a', client_generated_at: '2026-09-16T09:00:00.000Z', subtotal_cents: 500, tax_cents: 50, total_cents: 550 }),
  ]
  const precise: LocalRefund = { id: 'precise-refund', store_id: 'store-a', order_id: 'precise-mixed', amount_cents: 100, reason: null, refunded_by: 'owner', created_at: '2026-09-16T10:00:00.000Z' }
  const report = calculateLocalSalesReport('store-a', '2026-09-16', 'Asia/Karachi', {
    orders, items: [item('legacy-mixed', 2), item('precise-mixed', 1)],
    payments: [payment('legacy-mixed', 'cash', 1100), payment('precise-mixed', 'cash', 550)], outbox: [],
    refunds: [precise],
    // No refund_items row for the precise refund keeps its own delta at zero here (the test is
    // about path selection, not the split math, which the previous test already covers) — it
    // still must count toward refundedCount/refundedAmountCents.
    refundItems: [],
  })
  assert.equal(report.netSalesCents, 0 + 500, 'legacy order fully reversed; precise order (zero-item refund) untouched')
  assert.equal(report.refundedAmountCents, 1100 + 100)
  assert.equal(report.refundedCount, 2, 'one legacy-path event, one precise-path event')
})

test('returns integer zero values for a day without orders and treats old discounts as zero', () => {
  const empty = calculateLocalSalesReport('store-a', '2026-09-17', 'UTC', { orders: [], items: [], payments: [], outbox: [] })
  assert.equal(empty.averageSaleCents, 0)
  assert.equal(empty.completedOrderCount, 0)
  const legacy = calculateLocalSalesReport('store-a', '2026-09-16', 'UTC', {
    orders: [order({ id: 'legacy', store_id: 'store-a', client_generated_at: '2026-09-16T23:59:00.000Z' })], items: [], payments: [], outbox: [],
  })
  assert.equal(legacy.discountCents, 0)
  assert.equal(legacy.netSalesCents, 1000)
})
