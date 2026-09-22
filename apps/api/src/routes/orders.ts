import { createHash, randomUUID } from 'node:crypto'
import { Router } from 'express'
import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { ApiError, requireStoreMember, requireStoreManager, sendApiError } from './auth.js'
import { boundedInteger, calculateDiscountedLine, discountNeedsManagerApproval, MAX_CENTS, splitOrderItemRefundAmount, sumDiscountedLines, type LineDiscount } from '../../../../packages/domain/src/money.js'
import { requireCashierTerminal, requireDeviceTerminal } from '../terminal-auth/routes.js'

/** Same action.verb / short descriptive target convention as terminal-auth's/inventory.ts's own
 * audit() helper — duplicated per-file rather than shared, matching this codebase's existing
 * convention (see apps/api/src/routes/audit.ts's own comment on the same choice). */
async function audit(client: PoolClient, storeId: string, actorId: string, action: string, target: string): Promise<void> {
  await client.query('insert into public.audit_log(store_id, actor_id, action, target) values ($1,$2,$3,$4)', [storeId, actorId, action, target])
}

export const ordersRouter = Router()
export const terminalOrdersRouter = Router()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type JsonRecord = Record<string, unknown>
function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'validation_failed', `${name} is required.`)
  return value as JsonRecord
}
function text(value: unknown, name: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(422, 'validation_failed', `${name} is invalid.`)
  return value
}
function id(value: unknown, name: string): string {
  const result = text(value, name, 36)
  if (!uuid.test(result)) throw new ApiError(422, 'validation_failed', `${name} must be a UUID.`)
  return result
}
function cents(value: unknown, name: string, max = MAX_CENTS): number {
  try { return boundedInteger(value as number, name, 0, max) }
  catch { throw new ApiError(422, 'validation_failed', `${name} must be valid integer cents.`) }
}
function timestamp(value: unknown, name: string): string {
  const result = text(value, name, 40)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new ApiError(422, 'validation_failed', `${name} must be a valid UTC timestamp.`)
  }
  return result
}
// A line may send discount_kind/discount_value together, or omit both for no discount.
function parseDiscount(item: JsonRecord, label: string): LineDiscount {
  const kind = item.discount_kind
  if (kind === null || kind === undefined) {
    if (item.discount_value !== null && item.discount_value !== undefined) throw new ApiError(422, 'validation_failed', `${label} discount value must be empty when no discount is applied.`)
    return null
  }
  if (kind !== 'percent' && kind !== 'fixed') throw new ApiError(422, 'validation_failed', `${label} discount kind is invalid.`)
  if (!Number.isSafeInteger(item.discount_value) || (item.discount_value as number) < 0) throw new ApiError(422, 'validation_failed', `${label} discount value is invalid.`)
  return kind === 'percent' ? { kind: 'percent', bps: item.discount_value as number } : { kind: 'fixed', cents: item.discount_value as number }
}

export function validateOperation(raw: unknown) {
  const body = record(raw, 'Operation')
  const order = record(body.order, 'Order')
  const payment = record(body.payment, 'Payment')
  const items = body.items
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw new ApiError(422, 'validation_failed', 'An order needs 1 to 100 items.')
  const storeId = id(order.store_id, 'Store ID')
  const customerId = order.customer_id === null || order.customer_id === undefined ? null : id(order.customer_id, 'Customer ID')
  const operationId = id(body.operation_id, 'Operation ID')
  if (operationId !== id(order.id, 'Order ID')) throw new ApiError(422, 'validation_failed', 'Order ID must match operation ID.')
  const parsedItems = items.map((rawItem, index) => {
    const item = record(rawItem, `Item ${index + 1}`)
    if (!Number.isSafeInteger(item.catalog_version) || (item.catalog_version as number) < 1 || (item.catalog_version as number) > MAX_CENTS) {
      throw new ApiError(422, 'validation_failed', `Item ${index + 1} catalog version is invalid.`)
    }
    const price = cents(item.snapshot_price_cents, 'Unit price')
    const discount = parseDiscount(item, `Item ${index + 1}`)
    let line: ReturnType<typeof calculateDiscountedLine>
    try { line = calculateDiscountedLine(price, item.quantity as number, item.snapshot_tax_bps as number, discount) }
    catch { throw new ApiError(422, 'validation_failed', `Item ${index + 1} has invalid quantity, tax, discount or amount.`) }
    if (line.subtotalCents !== item.subtotal_cents || line.discountAppliedCents !== item.discount_applied_cents ||
        line.taxableCents !== item.taxable_cents || line.taxCents !== item.tax_cents || line.totalCents !== item.total_cents) {
      throw new ApiError(422, 'total_mismatch', `Item ${index + 1} totals do not match.`)
    }
    return { id: id(item.id, 'Item ID'), product_id: id(item.product_id, 'Product ID'),
      snapshot_name: text(item.snapshot_name, 'Item name'), snapshot_sku: text(item.snapshot_sku, 'Item SKU', 80),
      snapshot_price_cents: price, snapshot_tax_bps: item.snapshot_tax_bps as number,
      catalog_version: item.catalog_version as number, quantity: item.quantity as number,
      discount_kind: discount?.kind ?? null, discount_value: discount ? (discount.kind === 'percent' ? discount.bps : discount.cents) : null,
      subtotal_cents: line.subtotalCents, discount_applied_cents: line.discountAppliedCents,
      taxable_cents: line.taxableCents, tax_cents: line.taxCents, total_cents: line.totalCents }
  })
  if (new Set(parsedItems.map(item => item.id)).size !== parsedItems.length) {
    throw new ApiError(422, 'validation_failed', 'Item IDs must be unique within a sale.')
  }
  let totals: ReturnType<typeof sumDiscountedLines>
  try {
    totals = sumDiscountedLines(parsedItems.map(item => ({ subtotalCents: item.subtotal_cents, discountAppliedCents: item.discount_applied_cents,
      taxableCents: item.taxable_cents, taxCents: item.tax_cents, totalCents: item.total_cents })))
  } catch { throw new ApiError(422, 'total_mismatch', 'Order exceeds the supported money range.') }
  if (totals.subtotalCents !== order.subtotal_cents || totals.discountCents !== order.discount_cents ||
      totals.taxCents !== order.tax_cents || totals.totalCents !== order.total_cents) {
    throw new ApiError(422, 'total_mismatch', 'Order totals do not match line totals.')
  }
  const employeeId = order.employee_id === null || order.employee_id === undefined ? null : id(order.employee_id, 'Employee ID')
  const managerId = order.manager_id === null || order.manager_id === undefined ? null : id(order.manager_id, 'Manager ID')
  const managerApprovedAt = order.manager_approved_at === null || order.manager_approved_at === undefined ? null : timestamp(order.manager_approved_at, 'Manager approval time')
  if ((managerId === null) !== (managerApprovedAt === null)) throw new ApiError(422, 'validation_failed', 'Manager approval evidence is incomplete.')
  const needsApproval = parsedItems.some(item => discountNeedsManagerApproval(item.subtotal_cents, item.discount_applied_cents))
  if (needsApproval && managerId === null) throw new ApiError(422, 'validation_failed', 'A discount on this sale requires manager approval.')
  const method = payment.method
  if (method !== 'cash' && method !== 'card') throw new ApiError(422, 'validation_failed', 'Payment method is invalid.')
  const amount = cents(payment.amount_cents, 'Payment amount')
  const tendered = cents(payment.tendered_cents, 'Tendered amount')
  const change = cents(payment.change_cents, 'Change amount')
  if (amount !== totals.totalCents || (method === 'cash' && tendered !== amount + change) ||
      (method === 'card' && (tendered !== amount || change !== 0))) {
    throw new ApiError(422, 'total_mismatch', 'Payment does not balance with the order.')
  }
  const generatedAt = timestamp(order.client_generated_at, 'Sale time')
  if (!Number.isSafeInteger(order.catalog_version) || (order.catalog_version as number) < 1 || (order.catalog_version as number) > MAX_CENTS) {
    throw new ApiError(422, 'validation_failed', 'Catalog version is invalid.')
  }
  return { operationId, storeId, items: parsedItems, totals,
    order: { customer_id: customerId, receipt_number: text(order.receipt_number, 'Receipt number', 100),
      catalog_version: order.catalog_version as number,
      client_generated_at: generatedAt, employee_id: employeeId, manager_id: managerId, manager_approved_at: managerApprovedAt },
    payment: { id: id(payment.id, 'Payment ID'), method, amount_cents: amount,
      tendered_cents: tendered, change_cents: change,
      reference: payment.reference === null || payment.reference === undefined ? null : text(payment.reference, 'Card reference', 120) } }
}

/**
 * Inserts an already-validated order/items/payment, decrements stock, and appends the matching
 * change-feed entries — everything `push()` does to an order once it's past request-level
 * concerns (terminal/member auth, the idempotency-ledger replay check). Composable with other
 * per-store-locked writes (see `exchange()`, which runs this alongside `performRefund` inside one
 * transaction) — this function does not begin/commit or write its own ledger row; the caller does.
 */
async function performOrderCreation(client: PoolClient, operation: ReturnType<typeof validateOperation>): Promise<{ acceptedCheckpoint: string }> {
  const store = await client.query('select name,timezone,currency from public.stores where id=$1', [operation.storeId])
  if (!store.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Store no longer exists.')
  const productIds = [...new Set(operation.items.map(item => item.product_id))]
  const products = await client.query('select id from public.pos_products where store_id=$1 and id = any($2::uuid[])', [operation.storeId, productIds])
  if (products.rowCount !== productIds.length) throw new ApiError(422, 'cross_store_reference', 'An item refers to a product outside this store.')
  if (operation.order.customer_id) {
    const customer = await client.query('select 1 from public.pos_customers where store_id=$1 and id=$2', [operation.storeId, operation.order.customer_id])
    if (!customer.rowCount) {
      // Customer was rejected or not yet synced — accept the order without the customer link
      // rather than blocking this paid sale from syncing permanently.
      // The local Dexie record retains the customer reference for the cashier's view.
      operation.order.customer_id = null
    }
  }
  if (operation.order.employee_id) {
    const employee = await client.query('select 1 from public.terminal_employees where store_id=$1 and id=$2', [operation.storeId, operation.order.employee_id])
    if (!employee.rowCount) {
      // Employee record was removed or never synced — accept the order without cashier
      // attribution rather than blocking this paid sale from syncing permanently.
      operation.order.employee_id = null
    }
  }
  if (operation.order.manager_id) {
    const manager = await client.query(
      "select 1 from public.terminal_employees where store_id=$1 and id=$2 and role='manager' and active=true",
      [operation.storeId, operation.order.manager_id])
    if (!manager.rowCount) throw new ApiError(422, 'validation_failed', 'Manager approval references an employee who is not an active manager for this store.')
  }
  await client.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
    subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,customer_id,employee_id,manager_id,manager_approved_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [operation.operationId, operation.storeId, operation.order.receipt_number, store.rows[0].currency,
      store.rows[0].name, store.rows[0].timezone, operation.totals.subtotalCents, operation.totals.discountCents, operation.totals.taxCents,
      operation.totals.totalCents, operation.order.catalog_version, operation.order.client_generated_at, operation.order.customer_id,
      operation.order.employee_id, operation.order.manager_id, operation.order.manager_approved_at])
  for (const item of operation.items) {
    await client.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
      snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,discount_kind,discount_value,
      subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [item.id, operation.storeId, operation.operationId, item.product_id, item.snapshot_name, item.snapshot_sku,
        item.snapshot_price_cents, item.snapshot_tax_bps, item.catalog_version, item.quantity, item.discount_kind, item.discount_value,
        item.subtotal_cents, item.discount_applied_cents, item.taxable_cents, item.tax_cents, item.total_cents])
  }
  await client.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,reference,client_generated_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [operation.payment.id, operation.storeId, operation.operationId,
      operation.payment.method, operation.payment.amount_cents, operation.payment.tendered_cents,
      operation.payment.change_cents, operation.payment.reference, operation.order.client_generated_at])
  let position = BigInt((await client.query('select last_position::text from public.pos_sync_feed_state where store_id=$1', [operation.storeId])).rows[0].last_position)
  for (const productId of productIds) {
    const quantity = operation.items.filter(item => item.product_id === productId).reduce((sum, item) => sum + item.quantity, 0)
    await client.query(`insert into public.pos_inventory_movements(store_id,product_id,order_id,operation_id,delta,reason)
      values ($1,$2,$3,$4,$5,'sale')`, [operation.storeId, productId, operation.operationId, operation.operationId, -quantity])
    const stock = await client.query(`update public.pos_stock set current_stock=current_stock-$3, updated_at=now()
      where store_id=$1 and product_id=$2 and current_stock>=$3 returning current_stock`, [operation.storeId, productId, quantity])
    if (!stock.rows[0]) {
      const existing = await client.query('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [operation.storeId, productId])
      if (!existing.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Stock projection is missing for a product.')
      throw new ApiError(409, 'insufficient_stock', `Not enough stock for product ${productId} (have ${existing.rows[0].current_stock}, need ${quantity}).`)
    }
    position += 1n
    await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
      values ($1,$2,'stock',$3,$4)`, [operation.storeId, position.toString(), productId, { product_id: productId, current_stock: stock.rows[0].current_stock }])
  }
  position += 1n
  await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
    values ($1,$2,'order',$3,$4)`, [operation.storeId, position.toString(), operation.operationId, { receipt_number: operation.order.receipt_number }])
  await client.query('update public.pos_sync_feed_state set last_position=$2 where store_id=$1', [operation.storeId, position.toString()])
  return { acceptedCheckpoint: position.toString() }
}

async function push(req: import('express').Request, res: import('express').Response, terminal = false) {
  try {
    const operation = validateOperation(req.body)
    if (terminal) {
      const session = await requireDeviceTerminal(req, db)
      if (session.storeId !== operation.storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
      // Prefer the currently authenticated cashier's identity over whatever the client sent, so a
      // sale can't be attributed to a different employee than the one actually unlocked on this
      // device. A device-only session (queued sale synced after logout) has no cashier to check
      // against, so it falls back to the client-sent value's best-effort existence check below.
      try { operation.order.employee_id = (await requireCashierTerminal(req, db)).employeeId }
      catch { /* no active cashier session on this device right now */ }
    } else await requireStoreMember(req, operation.storeId)
    const hash = createHash('sha256').update(JSON.stringify(req.body)).digest('hex')
    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query('insert into public.pos_sync_feed_state(store_id) values ($1) on conflict do nothing', [operation.storeId])
      await client.query('select last_position from public.pos_sync_feed_state where store_id = $1 for update', [operation.storeId])
      const replay = await client.query('select payload_hash,result_json from public.pos_operation_ledger where store_id=$1 and operation_id=$2', [operation.storeId, operation.operationId])
      if (replay.rows[0]) {
        if (replay.rows[0].payload_hash !== hash) throw new ApiError(409, 'operation_id_conflict', 'This operation ID was used for another sale.')
        await client.query('commit')
        res.json(replay.rows[0].result_json)
        return
      }
      const { acceptedCheckpoint } = await performOrderCreation(client, operation)
      const result = { status: 'accepted', operation_id: operation.operationId, accepted_checkpoint: acceptedCheckpoint }
      await client.query(`insert into public.pos_operation_ledger(store_id,operation_id,payload_hash,status,result_json,accepted_checkpoint)
        values ($1,$2,$3,'accepted',$4,$5)`, [operation.storeId, operation.operationId, hash, result, acceptedCheckpoint])
      await client.query('commit')
      res.json(result)
    } catch (reason) { await client.query('rollback'); throw reason }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
}
// ---------------------------------------------------------------------------
// POST /orders/:id/refund — owner/manager partial or whole-order refund.
// Money-correctness code: held to the same review bar as checkout itself (validateOperation
// above). The original pos_orders/pos_order_items rows are never touched; a refund is its own
// append-only record, per docs/04_er_diagrams.md:98's suggested shape (reference the sale through
// order_id, the return through a separate refund_id — never the other way around). Any number of
// refunds may exist against one order now, as long as no line item is ever refunded past its
// originally sold quantity (enforced here, and backstopped by a DB trigger — see
// 202609230001_partial_refunds.sql).
// ---------------------------------------------------------------------------
interface RequestedRefundItem { order_item_id: string; quantity: number }

function parseRefundItems(raw: unknown): RequestedRefundItem[] | null {
  if (raw === null || raw === undefined) return null
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) {
    throw new ApiError(422, 'validation_failed', 'items must be a non-empty array of at most 100 entries.')
  }
  return raw.map((raw2, index) => {
    const item = record(raw2, `Refund item ${index + 1}`)
    return { order_item_id: id(item.order_item_id, `Refund item ${index + 1} order_item_id`), quantity: boundedInteger(item.quantity as number, `Refund item ${index + 1} quantity`, 1, 10_000) }
  })
}

/**
 * Refunds specific line items (or, when `requested` is null, everything still refundable) from an
 * already-validated order, inside a transaction the caller already began and locked (the same
 * per-store `pos_sync_feed_state ... for update` lock every mutation here takes — this function
 * does not lock or manage the transaction itself, so it can be composed with order-creation inside
 * one atomic exchange transaction later without a second, conflicting lock).
 */
async function performRefund(
  client: PoolClient, storeId: string, orderId: string, userId: string, reason: string | null,
  requested: RequestedRefundItem[] | null, exchangeOrderId: string | null,
): Promise<{ refund: { id: string; store_id: string; order_id: string; amount_cents: string; reason: string | null; refunded_by: string; created_at: string; exchange_order_id: string | null }; items: Array<{ order_item_id: string; product_id: string; quantity: number; amount_cents: number }> }> {
  const orderRes = await client.query('select 1 from public.pos_orders where store_id=$1 and id=$2', [storeId, orderId])
  if (!orderRes.rowCount) throw new ApiError(404, 'not_found', 'Order not found.')

  // One row per order item, with how much of it has already been refunded across any prior
  // refunds — the single source of truth both for "items omitted" (refund everything still
  // refundable) and for validating an explicit item selection.
  const lines = await client.query<{ id: string; product_id: string; original_quantity: number; total_cents: string; refunded_quantity: string; refunded_amount_cents: string }>(
    `select oi.id, oi.product_id, oi.quantity as original_quantity, oi.total_cents::text as total_cents,
       coalesce(sum(ri.quantity), 0)::text as refunded_quantity,
       coalesce(sum(ri.amount_cents), 0)::text as refunded_amount_cents
     from public.pos_order_items oi
     left join public.pos_refund_items ri on ri.store_id = oi.store_id and ri.order_item_id = oi.id
     where oi.store_id = $1 and oi.order_id = $2
     group by oi.id, oi.product_id, oi.quantity, oi.total_cents`,
    [storeId, orderId],
  )
  if (!lines.rowCount) throw new ApiError(422, 'validation_failed', 'Order has no line items to refund.')
  const byOrderItemId = new Map(lines.rows.map(row => [row.id, row]))

  const toRefund: Array<{ order_item_id: string; product_id: string; quantity: number; amount_cents: number }> = []
  if (requested === null) {
    for (const row of lines.rows) {
      const remaining = row.original_quantity - Number(row.refunded_quantity)
      if (remaining <= 0) continue
      const amountCents = splitOrderItemRefundAmount(row.original_quantity, Number(row.total_cents), Number(row.refunded_quantity), Number(row.refunded_amount_cents), remaining)
      toRefund.push({ order_item_id: row.id, product_id: row.product_id, quantity: remaining, amount_cents: amountCents })
    }
    if (!toRefund.length) throw new ApiError(422, 'nothing_to_refund', 'Every item on this order has already been fully refunded.')
  } else {
    for (const req of requested) {
      const row = byOrderItemId.get(req.order_item_id)
      if (!row) throw new ApiError(422, 'item_not_found', `Order item ${req.order_item_id} does not belong to this order.`)
      const remaining = row.original_quantity - Number(row.refunded_quantity)
      if (req.quantity > remaining) {
        throw new ApiError(422, 'over_refund', `Cannot refund ${req.quantity} of this item — only ${remaining} remain unrefunded.`)
      }
      const amountCents = splitOrderItemRefundAmount(row.original_quantity, Number(row.total_cents), Number(row.refunded_quantity), Number(row.refunded_amount_cents), req.quantity)
      toRefund.push({ order_item_id: row.id, product_id: row.product_id, quantity: req.quantity, amount_cents: amountCents })
    }
  }

  const amountCents = toRefund.reduce((sum, item) => sum + item.amount_cents, 0)
  const refundRes = await client.query<{ id: string; store_id: string; order_id: string; amount_cents: string; reason: string | null; refunded_by: string; created_at: string; exchange_order_id: string | null }>(
    `insert into public.pos_refunds (store_id, order_id, amount_cents, reason, refunded_by, exchange_order_id)
     values ($1,$2,$3,$4,$5,$6)
     returning id, store_id, order_id, amount_cents::text as amount_cents, reason, refunded_by, created_at, exchange_order_id`,
    [storeId, orderId, amountCents, reason, userId, exchangeOrderId],
  )
  const refundRow = refundRes.rows[0]

  for (const item of toRefund) {
    await client.query(
      `insert into public.pos_refund_items (store_id, refund_id, order_item_id, product_id, quantity, amount_cents)
       values ($1,$2,$3,$4,$5,$6)`,
      [storeId, refundRow.id, item.order_item_id, item.product_id, item.quantity, item.amount_cents],
    )
  }

  // Reverse stock once per distinct product among the refunded items.
  const byProduct = new Map<string, number>()
  for (const item of toRefund) byProduct.set(item.product_id, (byProduct.get(item.product_id) ?? 0) + item.quantity)

  let position = BigInt((await client.query('select last_position::text from public.pos_sync_feed_state where store_id=$1', [storeId])).rows[0].last_position)
  for (const [productId, quantity] of byProduct) {
    await client.query(
      `insert into public.pos_inventory_movements (store_id, product_id, order_id, operation_id, delta, reason)
       values ($1,$2,$3,gen_random_uuid(),$4,'refund')`,
      [storeId, productId, orderId, quantity],
    )
    const stock = await client.query(`update public.pos_stock set current_stock=current_stock+$3, updated_at=now()
      where store_id=$1 and product_id=$2 returning current_stock`, [storeId, productId, quantity])
    if (!stock.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Stock projection is missing for a refunded product.')
    position += 1n
    await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
      values ($1,$2,'stock',$3,$4)`, [storeId, position.toString(), productId, { product_id: productId, current_stock: stock.rows[0].current_stock }])
  }

  position += 1n
  await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
    values ($1,$2,'refund',$3,$4)`, [storeId, position.toString(), refundRow.id, { order_id: orderId, refund_id: refundRow.id, amount_cents: amountCents }])
  await client.query('update public.pos_sync_feed_state set last_position=$2 where store_id=$1', [storeId, position.toString()])

  await audit(client, storeId, userId, requested === null ? 'refund.full' : 'refund.partial', `Order ${orderId}: refund ${refundRow.id} (${amountCents} cents, ${toRefund.length} line item${toRefund.length === 1 ? '' : 's'})`)

  return { refund: refundRow, items: toRefund }
}

async function refund(req: import('express').Request, res: import('express').Response) {
  try {
    const orderId = id(req.params.id, 'Order ID')
    const body = req.body as Record<string, unknown>
    const storeId = id(body.store_id, 'Store ID')
    // operation_id is optional for backward compatibility with callers (today's Receipt screen)
    // that predate idempotent refunds — a missing one falls back to a fresh, never-replayable
    // UUID, which is exactly today's no-idempotency behavior, not a regression. A caller that
    // does send one gets real replay safety, same as push().
    const operationId = body.operation_id === null || body.operation_id === undefined ? randomUUID() : id(body.operation_id, 'Operation ID')
    const reason = body.reason === null || body.reason === undefined || body.reason === ''
      ? null : text(body.reason, 'Refund reason', 240)
    const items = parseRefundItems(body.items)
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')

    const userId = await requireStoreManager(req, storeId)

    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query('insert into public.pos_sync_feed_state(store_id) values ($1) on conflict do nothing', [storeId])
      await client.query('select last_position from public.pos_sync_feed_state where store_id=$1 for update', [storeId])

      const replay = await client.query('select payload_hash,result_json from public.pos_operation_ledger where store_id=$1 and operation_id=$2', [storeId, operationId])
      if (replay.rows[0]) {
        if (replay.rows[0].payload_hash !== hash) throw new ApiError(409, 'operation_id_conflict', 'This operation ID was used for a different refund.')
        await client.query('commit')
        res.status(201).json(replay.rows[0].result_json)
        return
      }

      const result = await performRefund(client, storeId, orderId, userId, reason, items, null)

      const position = (await client.query('select last_position::text as last_position from public.pos_sync_feed_state where store_id=$1', [storeId])).rows[0].last_position
      await client.query(
        `insert into public.pos_operation_ledger(store_id,operation_id,payload_hash,status,result_json,accepted_checkpoint)
         values ($1,$2,$3,'accepted',$4,$5)`,
        [storeId, operationId, hash, result, position],
      )

      await client.query('commit')
      res.status(201).json(result)
    } catch (reason2) {
      await client.query('rollback')
      throw reason2
    } finally {
      client.release()
    }
  } catch (reason) {
    sendApiError(res, reason)
  }
}

// ---------------------------------------------------------------------------
// POST /orders/:id/exchange — owner/manager only. Returns specific item(s) from a past order and
// rings up replacement item(s) in one atomic action, by composing performRefund() and
// performOrderCreation() inside a single transaction/per-store lock — not two HTTP round-trips,
// so a half-applied exchange (item taken back but no replacement rung up, or the reverse) can
// never persist. Deliberately does zero new money math: the return is refunded at exactly its
// original sold price/tax (performRefund, unmodified), the replacement is sold at exactly today's
// catalog price with full server-side validation (performOrderCreation, unmodified — the same
// path every ordinary sale goes through). The two are linked by pos_refunds.exchange_order_id,
// purely for display/audit. What the customer nets owing or getting back is a derived,
// display-only figure computed here (new_order total minus refund amount, may be negative) —
// never written as a payment amount on either row; each row's own amount is independently correct
// as if the two had happened separately.
// ---------------------------------------------------------------------------
async function exchange(req: import('express').Request, res: import('express').Response) {
  try {
    const orderId = id(req.params.id, 'Order ID')
    const body = req.body as Record<string, unknown>
    const storeId = id(body.store_id, 'Store ID')
    const operationId = id(body.operation_id, 'Operation ID')
    const reason = body.reason === null || body.reason === undefined || body.reason === ''
      ? null : text(body.reason, 'Exchange reason', 240)
    const returnItems = parseRefundItems(body.return_items)
    if (!returnItems) throw new ApiError(422, 'validation_failed', 'return_items is required and must be a non-empty array.')
    const newOrderOperation = validateOperation(body.new_order)
    if (newOrderOperation.storeId !== storeId) throw new ApiError(422, 'cross_store_reference', 'The replacement order must be for the same store as the exchange.')
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')

    const userId = await requireStoreManager(req, storeId)

    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query('insert into public.pos_sync_feed_state(store_id) values ($1) on conflict do nothing', [storeId])
      await client.query('select last_position from public.pos_sync_feed_state where store_id=$1 for update', [storeId])

      const replay = await client.query('select payload_hash,result_json from public.pos_operation_ledger where store_id=$1 and operation_id=$2', [storeId, operationId])
      if (replay.rows[0]) {
        if (replay.rows[0].payload_hash !== hash) throw new ApiError(409, 'operation_id_conflict', 'This operation ID was used for a different exchange.')
        await client.query('commit')
        res.status(201).json(replay.rows[0].result_json)
        return
      }

      const { acceptedCheckpoint } = await performOrderCreation(client, newOrderOperation)
      // The replacement order's own operation_id is independently ledgered too (same shape a
      // plain POST /push would have written), so a later retry of just that half — e.g. a stray
      // client replaying only the new-sale part — replays cleanly instead of hitting a duplicate
      // pos_orders primary key.
      const newOrderHash = createHash('sha256').update(JSON.stringify(body.new_order)).digest('hex')
      const newOrderResult = { status: 'accepted', operation_id: newOrderOperation.operationId, accepted_checkpoint: acceptedCheckpoint }
      await client.query(
        `insert into public.pos_operation_ledger(store_id,operation_id,payload_hash,status,result_json,accepted_checkpoint)
         values ($1,$2,$3,'accepted',$4,$5)`,
        [storeId, newOrderOperation.operationId, newOrderHash, newOrderResult, acceptedCheckpoint],
      )

      const refundResult = await performRefund(client, storeId, orderId, userId, reason, returnItems, newOrderOperation.operationId)
      const netAmountCents = newOrderOperation.totals.totalCents - Number(refundResult.refund.amount_cents)

      await audit(client, storeId, userId, 'order.exchange',
        `Order ${orderId}: exchange -> new order ${newOrderOperation.operationId} (refund ${refundResult.refund.amount_cents} cents, new sale ${newOrderOperation.totals.totalCents} cents, net ${netAmountCents} cents)`)

      const position = (await client.query('select last_position::text as last_position from public.pos_sync_feed_state where store_id=$1', [storeId])).rows[0].last_position
      const result = { refund: refundResult.refund, refund_items: refundResult.items, new_order: newOrderResult, net_amount_cents: netAmountCents }
      await client.query(
        `insert into public.pos_operation_ledger(store_id,operation_id,payload_hash,status,result_json,accepted_checkpoint)
         values ($1,$2,$3,'accepted',$4,$5)`,
        [storeId, operationId, hash, result, position],
      )

      await client.query('commit')
      res.status(201).json(result)
    } catch (reason2) {
      await client.query('rollback')
      throw reason2
    } finally {
      client.release()
    }
  } catch (reason) {
    sendApiError(res, reason)
  }
}

ordersRouter.post('/push', (req, res) => void push(req, res))
terminalOrdersRouter.post('/push', (req, res) => void push(req, res, true))
ordersRouter.post('/:id/refund', (req, res) => void refund(req, res))
ordersRouter.post('/:id/exchange', (req, res) => void exchange(req, res))
