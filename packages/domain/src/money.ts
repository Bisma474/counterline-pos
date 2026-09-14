export type LineCalculationInput = {
  unitPriceCents: number
  quantity: number
  taxRateBps: number
  discountCents?: number
  discountBps?: number
}

export type LineCalculation = {
  subtotalCents: number
  discountCents: number
  taxableCents: number
  taxCents: number
  totalCents: number
}

const MAX_CENTS = 1_000_000_000

function assertInteger(value: number, name: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} through ${max}.`)
}

export function calculateLine(input: LineCalculationInput): LineCalculation {
  assertInteger(input.unitPriceCents, 'Unit price', 0, MAX_CENTS)
  assertInteger(input.quantity, 'Quantity', 1, 10_000)
  assertInteger(input.taxRateBps, 'Tax rate', 0, 10_000)
  if (input.discountCents !== undefined && input.discountBps !== undefined) throw new Error('A line can have either a fixed or percentage discount, not both.')

  const subtotalCents = input.unitPriceCents * input.quantity
  assertInteger(subtotalCents, 'Line subtotal', 0, MAX_CENTS)
  const percentageDiscount = input.discountBps === undefined ? 0 : Math.floor((subtotalCents * input.discountBps + 5_000) / 10_000)
  if (input.discountBps !== undefined) assertInteger(input.discountBps, 'Discount rate', 0, 10_000)
  const discountCents = input.discountCents ?? percentageDiscount
  assertInteger(discountCents, 'Discount', 0, subtotalCents)
  const taxableCents = subtotalCents - discountCents
  const taxCents = Math.floor((taxableCents * input.taxRateBps + 5_000) / 10_000)
  const totalCents = taxableCents + taxCents
  assertInteger(totalCents, 'Line total', 0, MAX_CENTS)
  return { subtotalCents, discountCents, taxableCents, taxCents, totalCents }
}

export function formatCents(cents: number, currency = 'USD', locale = 'en-US') {
  assertInteger(cents, 'Amount', 0, MAX_CENTS)
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100)
}
