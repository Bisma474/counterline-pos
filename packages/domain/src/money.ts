export const MAX_CENTS = 1_000_000_000

export function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`)
  }
  return value
}

export function calculateLine(unitPriceCents: number, quantity: number, taxRateBps: number) {
  boundedInteger(unitPriceCents, 'Unit price', 0, MAX_CENTS)
  boundedInteger(quantity, 'Quantity', 1, 10_000)
  boundedInteger(taxRateBps, 'Tax rate', 0, 10_000)
  const subtotalCents = boundedInteger(unitPriceCents * quantity, 'Line subtotal', 0, MAX_CENTS)
  const taxCents = Math.floor((subtotalCents * taxRateBps + 5_000) / 10_000)
  const totalCents = boundedInteger(subtotalCents + taxCents, 'Line total', 0, MAX_CENTS)
  return { subtotalCents, taxCents, totalCents }
}

export function sumLines(lines: ReturnType<typeof calculateLine>[]) {
  return lines.reduce((sum, line) => ({
    subtotalCents: boundedInteger(sum.subtotalCents + line.subtotalCents, 'Subtotal', 0, MAX_CENTS),
    taxCents: boundedInteger(sum.taxCents + line.taxCents, 'Tax', 0, MAX_CENTS),
    totalCents: boundedInteger(sum.totalCents + line.totalCents, 'Total', 0, MAX_CENTS),
  }), { subtotalCents: 0, taxCents: 0, totalCents: 0 })
}

export function parseCents(input: string): number {
  const normalized = input.trim()
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Enter a valid amount with up to two decimal places.')
  const [units, fraction = ''] = normalized.split('.')
  return boundedInteger(Number(units) * 100 + Number(fraction.padEnd(2, '0')), 'Tender', 0, MAX_CENTS)
}

export function formatCents(cents: number, currency = 'USD'): string {
  boundedInteger(cents, 'Amount', 0, MAX_CENTS)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
}
