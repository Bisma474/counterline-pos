import Dexie, { Table } from 'dexie'

export type LocalOrder = { id: string; receiptNumber: string; createdAt: string; subtotalCents: number; taxCents: number; totalCents: number; paymentMethod: 'cash' | 'external_card'; tenderedCents: number; changeCents: number; status: 'pending_sync' }
export type LocalOrderItem = { id: string; orderId: string; productId: string; name: string; sku: string; unitPriceCents: number; quantity: number; taxRateBps: number; lineSubtotalCents: number; lineTaxCents: number; lineTotalCents: number }
export type OutboxOperation = { id: string; entityType: 'order'; status: 'pending'; createdAt: string; payload: unknown }
export type PosMetadata = { key: string; value: string }

class CounterlineDatabase extends Dexie {
  orders!: Table<LocalOrder, string>
  orderItems!: Table<LocalOrderItem, string>
  outbox!: Table<OutboxOperation, string>
  metadata!: Table<PosMetadata, string>
  constructor() { super('counterline-pos'); this.version(1).stores({ orders: 'id, createdAt, status', orderItems: 'id, orderId, productId', outbox: 'id, status, createdAt', metadata: 'key' }) }
}

export const localDb = new CounterlineDatabase()

export async function nextReceiptNumber() {
  const key = 'receipt-sequence'
  const current = Number((await localDb.metadata.get(key))?.value ?? '0')
  const next = current + 1
  await localDb.metadata.put({ key, value: String(next) })
  return `LOCAL-${String(next).padStart(6, '0')}`
}
