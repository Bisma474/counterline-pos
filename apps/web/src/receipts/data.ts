import { posDb, type LocalOrder, type LocalOrderItem, type LocalPayment, type LocalRefundItem } from '../lib/db'

export interface SavedReceipt { order: LocalOrder; items: LocalOrderItem[]; payment: LocalPayment; refundItems: LocalRefundItem[] }

// One read-only transaction: never reconstruct a historical sale from the catalog. Reads
// refund_items too (not just the order's own refunded_at/refunded_amount_cents summary fields) so
// a caller can show exactly how much of each line remains refundable — Dexie's liveQuery tracks
// every table touched during the query function, so a later, separate partial refund against this
// same order still re-triggers subscribers automatically.
export async function readReceipt(storeId: string, orderId: string): Promise<SavedReceipt | null> {
  return posDb.transaction('r', posDb.orders, posDb.order_items, posDb.payments, posDb.refund_items, async () => {
    const order = await posDb.orders.get(orderId)
    if (!order || order.store_id !== storeId) return null
    const items = await posDb.order_items.where('order_id').equals(orderId).toArray()
    const payment = await posDb.payments.where('order_id').equals(orderId).first()
    if (!items.length || !payment) throw new Error('This saved receipt is incomplete. Keep the local data and ask a manager to review it. Do not charge again.')
    const refundItems = await posDb.refund_items.where('order_item_id').anyOf(items.map(item => item.id)).toArray()
    return { order, items, payment, refundItems }
  })
}

/** How much of a single order line has been refunded so far, across any number of separate
 * partial refunds — the same quantity the server's over-refund check sums, computed locally. */
export function refundedQuantity(orderItemId: string, refundItems: LocalRefundItem[]): number {
  return refundItems.filter(entry => entry.order_item_id === orderItemId).reduce((sum, entry) => sum + entry.quantity, 0)
}

export function saleDate(order: LocalOrder): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: order.timezone_snapshot }).format(new Date(order.client_generated_at))
  } catch { return `${order.client_generated_at} (recorded date; timezone unavailable)` }
}

export function saleDay(order: LocalOrder): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: order.timezone_snapshot }).formatToParts(new Date(order.client_generated_at))
    const value = (type: string) => parts.find(part => part.type === type)?.value
    return `${value('year')}-${value('month')}-${value('day')}`
  } catch { return '' }
}

export const syncLabel = (order: LocalOrder) => order.sync_status === 'failed' ? 'Rejected / needs review' : order.sync_status === 'synced' ? 'Synced' : 'Pending sync'
