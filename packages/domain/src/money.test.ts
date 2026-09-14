import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateLine } from './money.js'

test('calculates integer-cent tax and percentage discount with half-up rounding', () => {
  assert.deepEqual(calculateLine({ unitPriceCents: 199, quantity: 2, discountBps: 1_000, taxRateBps: 500 }), { subtotalCents: 398, discountCents: 40, taxableCents: 358, taxCents: 18, totalCents: 376 })
})

test('rejects discounts larger than a line subtotal', () => {
  assert.throws(() => calculateLine({ unitPriceCents: 100, quantity: 1, discountCents: 101, taxRateBps: 0 }))
})
