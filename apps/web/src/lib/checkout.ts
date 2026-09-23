import { calculateDiscountedLine, sumDiscountedLines, boundedInteger, discountNeedsManagerApproval, MAX_CENTS } from '../../../../packages/domain/src/money'
import { posDb, type LocalOrder, type LocalOrderItem, type LocalPayment, type OutboxEntry } from './db'
import type { CartItem } from './pos-store'

// Evidence that a manager authorized a discount above the cashier's independent 20% authority.
export interface ManagerApprovalEvidence { managerId: string; approvedAt: string }

export async function completeLocalSale(items: CartItem[], storeId: string, method: 'cash' | 'card', tenderedCents: number, reference: string | null, customerId: string | null = null, employeeId: string | null = null, approval: ManagerApprovalEvidence | null = null) {
  if (!items.length) throw new Error('Add a product before checkout.')
  if (items.some(item => item.storeId !== storeId)) throw new Error('Cart contains a product from another store. Clear the cart and try again.')
  const config = await posDb.store_config.get(storeId)
  if (!config) throw new Error('Store catalog has not been downloaded to this browser.')
  const customer = customerId ? await posDb.customers.get(customerId) : null
  if (customerId && (!customer || customer.store_id !== storeId)) throw new Error('Selected customer does not belong to this store.')
  const lines = items.map(item => calculateDiscountedLine(item.unitPriceCents, item.quantity, item.taxRateBps, item.discount))
  const totals = sumDiscountedLines(lines)
  if (!approval && lines.some(line => discountNeedsManagerApproval(line.subtotalCents, line.discountAppliedCents))) {
    throw new Error('A discount needs manager approval before this sale can complete.')
  }
  boundedInteger(tenderedCents, 'Tender', 0, MAX_CENTS)
  if (tenderedCents < totals.totalCents) throw new Error('Amount received must cover the sale.')
  if (method === 'card' && tenderedCents !== totals.totalCents) throw new Error('Card amount must equal the sale total.')
  const operationId = crypto.randomUUID()
  const now = new Date().toISOString()
  let receiptNumber = ''
  await posDb.transaction('rw', [posDb.orders, posDb.order_items, posDb.payments,
    posDb.outbox, posDb.stock_adjustments, posDb.sync_metadata, posDb.products], async () => {
      for (const item of items) {
        const product = await posDb.products.get(item.productId)
        if ((item.parentProductId && !product) || (product && (product.store_id !== storeId || !product.active || product.is_draft))) {
          throw new Error(`${item.name} is no longer available for sale. Remove it from the cart and refresh the catalog.`)
        }
      }
      const prefixRow = await posDb.sync_metadata.get(`receipt_prefix:${storeId}`)
      const prefix = prefixRow?.value ?? `LOCAL-${crypto.randomUUID().toUpperCase()}-`
      const sequenceKey = `receipt_seq:${storeId}`
      const sequence = Number((await posDb.sync_metadata.get(sequenceKey))?.value ?? '0') + 1
      if (!Number.isSafeInteger(sequence)) throw new Error('Receipt sequence is exhausted.')
      receiptNumber = `${prefix}${String(sequence).padStart(6, '0')}`
      const order: LocalOrder = { id: operationId, store_id: storeId, receipt_number: receiptNumber,
        subtotal_cents: totals.subtotalCents, discount_cents: totals.discountCents, tax_cents: totals.taxCents, total_cents: totals.totalCents,
        catalog_version: config.catalog_version, client_generated_at: now, sync_status: 'pending',
        currency: config.currency, store_name_snapshot: config.name, timezone_snapshot: config.timezone,
        accepted_checkpoint: null, failure_reason: customer && customer.sync_status !== 'synced' ? 'Waiting for customer upload.' : null,
        customer_id: customerId, employee_id: employeeId, manager_id: approval?.managerId ?? null, manager_approved_at: approval?.approvedAt ?? null }
      const orderItems: LocalOrderItem[] = items.map((item, index) => ({ id: crypto.randomUUID(),
        order_id: operationId, product_id: item.productId, snapshot_name: item.name, snapshot_sku: item.sku,
        snapshot_price_cents: item.unitPriceCents, snapshot_tax_bps: item.taxRateBps, catalog_version: item.catalogVersion, quantity: item.quantity,
        subtotal_cents: lines[index].subtotalCents, discount_kind: item.discount?.kind ?? null,
        discount_value: item.discount ? (item.discount.kind === 'percent' ? item.discount.bps : item.discount.cents) : null,
        discount_applied_cents: lines[index].discountAppliedCents, taxable_cents: lines[index].taxableCents,
        tax_cents: lines[index].taxCents, total_cents: lines[index].totalCents }))
      const payment: LocalPayment = { id: crypto.randomUUID(), order_id: operationId, method,
        amount_cents: totals.totalCents, tendered_cents: tenderedCents,
        change_cents: method === 'cash' ? tenderedCents - totals.totalCents : 0, reference }
      const payload = { operation_id: operationId, order, items: orderItems, payment }
      const outbox: OutboxEntry = { store_id: storeId, operation_id: operationId, order_id: operationId, status: 'pending',
        failure_reason: null, failure_kind: null, reason_code: null, attempt_count: 0,
        lease_owner: null, lease_expires_at: null, accepted_checkpoint: null,
        next_attempt_at: now, created_at: now, payload: JSON.stringify(payload), entity_type: 'order',
        depends_on: customer?.creating_operation_id && customer.sync_status !== 'synced' ? [customer.creating_operation_id] : [] }
      await posDb.sync_metadata.put({ key: `receipt_prefix:${storeId}`, value: prefix })
      await posDb.sync_metadata.put({ key: sequenceKey, value: String(sequence) })
      await posDb.orders.add(order)
      await posDb.order_items.bulkAdd(orderItems)
      await posDb.payments.add(payment)
      for (const item of items) await posDb.stock_adjustments.add({ operation_id: operationId,
        product_id: item.productId, delta: -item.quantity, accepted_checkpoint: null })
      await posDb.outbox.add(outbox)
    })
  return { operationId, receiptNumber, totalCents: totals.totalCents }
}

export interface ExchangeReturnItem { orderItemId: string; quantity: number }

/**
 * Returns specific item(s) from a past order and rings up replacement item(s), atomically, via
 * POST /orders/:id/exchange. Online-only by design — same precedent as InventoryScreen.tsx's
 * manual adjustments and cycle counts, another owner/manager-only backoffice action never queued
 * through the offline outbox. The server is the source of truth for both halves' final figures;
 * this function's local math (below) only builds the request and is re-derived, not trusted, by
 * the server. On success, the authoritative response is written straight into the local
 * orders/order_items/payments/refunds/refund_items tables — no outbox entry, since there's nothing
 * left to sync once the request has already succeeded.
 */
/**
 * Shared by the web (`completeLocalExchange`) and terminal (`completeLocalTerminalExchange`)
 * entry points below — everything about an exchange is identical between the two except how the
 * request actually gets sent (a web bearer token vs the terminal's cookie session plus a manager
 * approver id), which the caller supplies as `submit`.
 */
async function runExchange(
  originalOrderId: string,
  returnItems: ExchangeReturnItem[],
  replacementItems: CartItem[],
  storeId: string,
  method: 'cash' | 'card',
  tenderedCents: number,
  reference: string | null,
  submit: (body: Record<string, unknown>) => Promise<Response>,
) {
  if (!returnItems.length) throw new Error('Select at least one item to return.')
  if (!replacementItems.length) throw new Error('Add at least one replacement product.')
  if (replacementItems.some(item => item.storeId !== storeId)) throw new Error('Replacement cart contains a product from another store.')
  const config = await posDb.store_config.get(storeId)
  if (!config) throw new Error('Store catalog has not been downloaded to this browser.')
  const lines = replacementItems.map(item => calculateDiscountedLine(item.unitPriceCents, item.quantity, item.taxRateBps, null))
  const totals = sumDiscountedLines(lines)
  boundedInteger(tenderedCents, 'Tender', 0, MAX_CENTS)
  if (tenderedCents < totals.totalCents) throw new Error('Amount received must cover the replacement total.')
  if (method === 'card' && tenderedCents !== totals.totalCents) throw new Error('Card amount must equal the replacement total.')

  const exchangeOperationId = crypto.randomUUID()
  const newOrderOperationId = crypto.randomUUID()
  const now = new Date().toISOString()
  const prefixRow = await posDb.sync_metadata.get(`receipt_prefix:${storeId}`)
  const prefix = prefixRow?.value ?? `LOCAL-${crypto.randomUUID().toUpperCase()}-`
  const sequenceKey = `receipt_seq:${storeId}`
  const sequence = Number((await posDb.sync_metadata.get(sequenceKey))?.value ?? '0') + 1
  if (!Number.isSafeInteger(sequence)) throw new Error('Receipt sequence is exhausted.')
  const receiptNumber = `${prefix}${String(sequence).padStart(6, '0')}`

  const newOrderItems = replacementItems.map((item, index) => ({
    id: crypto.randomUUID(), product_id: item.productId, snapshot_name: item.name, snapshot_sku: item.sku,
    snapshot_price_cents: item.unitPriceCents, snapshot_tax_bps: item.taxRateBps, catalog_version: item.catalogVersion, quantity: item.quantity,
    discount_kind: null as 'percent' | 'fixed' | null, discount_value: null as number | null,
    subtotal_cents: lines[index].subtotalCents, discount_applied_cents: lines[index].discountAppliedCents,
    taxable_cents: lines[index].taxableCents, tax_cents: lines[index].taxCents, total_cents: lines[index].totalCents,
  }))
  const newOrderPayload = {
    operation_id: newOrderOperationId,
    order: { id: newOrderOperationId, store_id: storeId, receipt_number: receiptNumber, catalog_version: config.catalog_version,
      client_generated_at: now, subtotal_cents: totals.subtotalCents, discount_cents: totals.discountCents, tax_cents: totals.taxCents, total_cents: totals.totalCents,
      customer_id: null, employee_id: null, manager_id: null, manager_approved_at: null },
    items: newOrderItems,
    payment: { id: crypto.randomUUID(), method, amount_cents: totals.totalCents, tendered_cents: tenderedCents,
      change_cents: method === 'cash' ? tenderedCents - totals.totalCents : 0, reference },
  }

  const response = await submit({
    store_id: storeId, operation_id: exchangeOperationId,
    return_items: returnItems.map(item => ({ order_item_id: item.orderItemId, quantity: item.quantity })),
    new_order: newOrderPayload,
  })
  const data = await response.json() as {
    code?: string; message?: string
    refund?: { id: string; amount_cents: string; reason: string | null; refunded_by: string | null; created_at: string }
    refund_items?: Array<{ order_item_id: string; product_id: string; quantity: number; amount_cents: number }>
    new_order?: { accepted_checkpoint: string }
    net_amount_cents?: number
  }
  if (!response.ok || !data.refund || !data.refund_items || !data.new_order || data.net_amount_cents === undefined) {
    throw new Error(data.message ?? `Server error (${response.status})`)
  }
  const refund = data.refund, refundItems = data.refund_items, newOrder = data.new_order

  await posDb.transaction('rw', [posDb.orders, posDb.order_items, posDb.payments, posDb.refunds, posDb.refund_items], async () => {
    const originalOrder = await posDb.orders.get(originalOrderId)
    const newLocalOrder: LocalOrder = { id: newOrderOperationId, store_id: storeId, receipt_number: receiptNumber,
      subtotal_cents: totals.subtotalCents, discount_cents: totals.discountCents, tax_cents: totals.taxCents, total_cents: totals.totalCents,
      catalog_version: config.catalog_version, client_generated_at: now, sync_status: 'synced',
      currency: config.currency, store_name_snapshot: config.name, timezone_snapshot: config.timezone,
      accepted_checkpoint: newOrder.accepted_checkpoint, failure_reason: null,
      customer_id: null, employee_id: null, manager_id: null, manager_approved_at: null }
    const newLocalItems: LocalOrderItem[] = newOrderItems.map(item => ({ ...item, order_id: newOrderOperationId }))
    const newLocalPayment: LocalPayment = { ...newOrderPayload.payment, order_id: newOrderOperationId }
    await posDb.orders.add(newLocalOrder)
    await posDb.order_items.bulkAdd(newLocalItems)
    await posDb.payments.add(newLocalPayment)
    await posDb.refunds.put({ id: refund.id, store_id: storeId, order_id: originalOrderId, amount_cents: Number(refund.amount_cents),
      reason: refund.reason, refunded_by: refund.refunded_by, exchange_order_id: newOrderOperationId, created_at: refund.created_at })
    await posDb.refund_items.bulkPut(refundItems.map(item => ({ id: `${refund.id}:${item.order_item_id}`, refund_id: refund.id,
      order_item_id: item.order_item_id, product_id: item.product_id, quantity: item.quantity, amount_cents: item.amount_cents })))
    if (originalOrder) {
      await posDb.orders.update(originalOrderId, {
        refunded_at: new Date().toISOString(),
        refunded_amount_cents: (originalOrder.refunded_amount_cents ?? 0) + Number(refund.amount_cents),
      })
    }
  })

  return { newOrderId: newOrderOperationId, receiptNumber, netAmountCents: data.net_amount_cents, refundAmountCents: Number(refund.amount_cents) }
}

export async function completeLocalExchange(
  originalOrderId: string,
  returnItems: ExchangeReturnItem[],
  replacementItems: CartItem[],
  storeId: string,
  method: 'cash' | 'card',
  tenderedCents: number,
  reference: string | null,
) {
  // Lazy import: keeps this module free of a top-level dependency on lib/supabase.ts (which reads
  // import.meta.env at module load time — fine under Vite, but crashes any Node-run test that
  // merely imports this file without a Vite runtime, even one that never calls this function).
  const { accessToken, configuredApiUrl } = await import('./catalog')
  return runExchange(originalOrderId, returnItems, replacementItems, storeId, method, tenderedCents, reference, async body => {
    const token = await accessToken()
    return fetch(`${configuredApiUrl()}/orders/${originalOrderId}/exchange`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  })
}

/**
 * Terminal counterpart to completeLocalExchange — same money math and same online-only design
 * (see the module-level comment on runExchange), but authenticated via the terminal's cookie
 * session instead of a web bearer token, and carrying `approverEmployeeId`: the PIN-based
 * terminal manager who approved this exchange (see ManagerApprovalModal), server-verified against
 * terminal_employees rather than auth.users.
 */
export async function completeLocalTerminalExchange(
  originalOrderId: string,
  returnItems: ExchangeReturnItem[],
  replacementItems: CartItem[],
  storeId: string,
  method: 'cash' | 'card',
  tenderedCents: number,
  reference: string | null,
  approverEmployeeId: string,
) {
  const { configuredApiUrl } = await import('./catalog')
  return runExchange(originalOrderId, returnItems, replacementItems, storeId, method, tenderedCents, reference, body =>
    fetch(`${configuredApiUrl()}/pos/orders/${originalOrderId}/exchange`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, approver_employee_id: approverEmployeeId }),
    }))
}
