import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateLine, parseCents } from '../../../../packages/domain/src/money.js'

// Import the validator after setting a harmless pool URL; these tests never open a connection.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { validateOperation } = await import('./orders.js')

const orderId = '37c68bc9-d138-4b6f-9f2f-1521e68e7e56'
const storeId = '90ca1d78-8027-4db8-8247-f4d8794b2680'
const productId = 'ff439cac-818c-43cc-924e-62f5cc049322'
const line = calculateLine(199, 2, 500)
function validOperation() {
  return { operation_id: orderId,
    order: { id: orderId, store_id: storeId, receipt_number: 'LOCAL-TEST-000001', catalog_version: 1,
      client_generated_at: '2026-09-15T09:00:00.000Z', subtotal_cents: line.subtotalCents,
      tax_cents: line.taxCents, total_cents: line.totalCents },
    items: [{ id: 'e5ae5b38-d2d6-453f-bb99-c552b2c69ebf', product_id: productId,
      snapshot_name: 'Test item', snapshot_sku: 'TEST-001', snapshot_price_cents: 199,
      snapshot_tax_bps: 500, catalog_version: 1, quantity: 2, subtotal_cents: line.subtotalCents,
      tax_cents: line.taxCents, total_cents: line.totalCents }],
    payment: { id: '954cb8ba-4a42-4692-a014-de59c102a741', method: 'cash',
      amount_cents: line.totalCents, tendered_cents: 500, change_cents: 500 - line.totalCents,
      reference: null } }
}

test('money rounds half a cent up and parses tender as integer cents', () => {
  assert.equal(calculateLine(10, 1, 500).taxCents, 1)
  assert.equal(parseCents('5.00'), 500)
  assert.throws(() => parseCents('5.001'))
})
test('accepts a balanced immutable sale snapshot', () => {
  const result = validateOperation(validOperation())
  assert.equal(result.totals.totalCents, line.totalCents)
  assert.equal(result.operationId, orderId)
})
test('rejects changed line totals and cash tender mismatch', () => {
  const changed = validOperation()
  changed.items[0].tax_cents += 1
  assert.throws(() => validateOperation(changed), /totals do not match/)
  const tender = validOperation()
  tender.payment.change_cents = 0
  assert.throws(() => validateOperation(tender), /Payment does not balance/)
})
test('rejects cross-operation identity and fractional money', () => {
  const changed = validOperation()
  changed.order.id = 'e5ae5b38-d2d6-453f-bb99-c552b2c69ebf'
  assert.throws(() => validateOperation(changed), /must match operation ID/)
  const fractional = validOperation()
  fractional.payment.amount_cents = 123.5
  assert.throws(() => validateOperation(fractional), /integer cents/)
})
