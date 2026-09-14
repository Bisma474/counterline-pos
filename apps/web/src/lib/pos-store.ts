import { create } from 'zustand'
import { calculateLine } from '../../../../packages/domain/src/money'
import { localDb, LocalOrderItem, nextReceiptNumber, OutboxOperation } from './local-db'

export type CatalogProduct = { id: string; name: string; sku: string; category: string; priceCents: number; taxRateBps: number; stock: number; art: string }
export type CartLine = CatalogProduct & { quantity: number }
export type PaymentMethod = 'cash' | 'external_card'

export const catalog: CatalogProduct[] = [
  { id: 'mug', name: 'Ceramic Mug', sku: 'MUG-001', category: 'Home', priceCents: 1800, taxRateBps: 800, stock: 24, art: 'mug' },
  { id: 'tote', name: 'Canvas Tote', sku: 'TOTE-001', category: 'Apparel', priceCents: 3200, taxRateBps: 800, stock: 12, art: 'tote' },
  { id: 'candle', name: 'Scented Candle', sku: 'CANDLE-001', category: 'Home', priceCents: 2800, taxRateBps: 800, stock: 4, art: 'candle' },
  { id: 'soap', name: 'Hand Soap', sku: 'SOAP-001', category: 'Wellness', priceCents: 2000, taxRateBps: 800, stock: 18, art: 'soap' },
  { id: 'oil', name: 'Olive Oil', sku: 'OIL-001', category: 'Food', priceCents: 2200, taxRateBps: 800, stock: 14, art: 'oil' },
  { id: 'tea', name: 'Tea Blend', sku: 'TEA-001', category: 'Food', priceCents: 1600, taxRateBps: 800, stock: 30, art: 'tea' },
]

export function cartTotals(lines: CartLine[]) { return lines.reduce((total, line) => { const calculated = calculateLine({ unitPriceCents: line.priceCents, quantity: line.quantity, taxRateBps: line.taxRateBps }); return { subtotalCents: total.subtotalCents + calculated.subtotalCents, taxCents: total.taxCents + calculated.taxCents, totalCents: total.totalCents + calculated.totalCents } }, { subtotalCents: 0, taxCents: 0, totalCents: 0 }) }

type PosState = { lines: CartLine[]; add: (product: CatalogProduct) => void; changeQuantity: (id: string, change: number) => void; remove: (id: string) => void; clear: () => void }
export const usePosStore = create<PosState>((set) => ({
  lines: [],
  add: (product) => set((state) => ({ lines: state.lines.some((line) => line.id === product.id) ? state.lines.map((line) => line.id === product.id ? { ...line, quantity: line.quantity + 1 } : line) : [...state.lines, { ...product, quantity: 1 }] })),
  changeQuantity: (id, change) => set((state) => ({ lines: state.lines.flatMap((line) => line.id !== id ? [line] : line.quantity + change <= 0 ? [] : [{ ...line, quantity: line.quantity + change }]) })),
  remove: (id) => set((state) => ({ lines: state.lines.filter((line) => line.id !== id) })),
  clear: () => set({ lines: [] }),
}))

export async function commitLocalSale(lines: CartLine[], paymentMethod: PaymentMethod, tenderedCents: number) {
  const totals = cartTotals(lines)
  if (!lines.length) throw new Error('Add at least one product before taking payment.')
  if (paymentMethod === 'cash' && tenderedCents < totals.totalCents) throw new Error('Cash received must cover the total.')
  const orderId = crypto.randomUUID(); let receiptNumber = ''; const createdAt = new Date().toISOString(); const changeCents = paymentMethod === 'cash' ? tenderedCents - totals.totalCents : 0
  const items: LocalOrderItem[] = lines.map((line) => { const calculated = calculateLine({ unitPriceCents: line.priceCents, quantity: line.quantity, taxRateBps: line.taxRateBps }); return { id: crypto.randomUUID(), orderId, productId: line.id, name: line.name, sku: line.sku, unitPriceCents: line.priceCents, quantity: line.quantity, taxRateBps: line.taxRateBps, lineSubtotalCents: calculated.subtotalCents, lineTaxCents: calculated.taxCents, lineTotalCents: calculated.totalCents } })
  await localDb.transaction('rw', localDb.orders, localDb.orderItems, localDb.outbox, localDb.metadata, async () => { receiptNumber = await nextReceiptNumber(); const operation: OutboxOperation = { id: orderId, entityType: 'order', status: 'pending', createdAt, payload: { orderId, receiptNumber, totals, paymentMethod, tenderedCents, items } }; await localDb.orders.add({ id: orderId, receiptNumber, createdAt, ...totals, paymentMethod, tenderedCents, changeCents, status: 'pending_sync' }); await localDb.orderItems.bulkAdd(items); await localDb.outbox.add(operation) })
  return { receiptNumber, changeCents, totals }
}
