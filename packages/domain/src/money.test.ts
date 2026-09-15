import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateLine, formatCents, parseCents, sumLines } from './money.ts'

test('rounds tax half up in integer cents', () => {
  assert.equal(calculateLine(10, 1, 500).taxCents, 1)
  assert.equal(calculateLine(199, 2, 500).taxCents, 20)
})
test('sums lines and rejects money overflow', () => {
  const totals = sumLines([calculateLine(1800, 2, 800), calculateLine(3200, 1, 0)])
  assert.deepEqual(totals, { subtotalCents: 6800, taxCents: 288, totalCents: 7088 })
  assert.throws(() => calculateLine(1_000_000_000, 2, 0))
})
test('parses only whole cents and formats currency', () => {
  assert.equal(parseCents('18.50'), 1850)
  assert.equal(formatCents(1850), '$18.50')
  assert.throws(() => parseCents('18.501'))
  assert.throws(() => parseCents('-1'))
})