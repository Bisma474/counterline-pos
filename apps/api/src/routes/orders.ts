import { createHash } from 'node:crypto'
import { Router } from 'express'
import { db } from '../db.js'
import { ApiError, requireStoreMember, sendApiError } from './auth.js'
import { boundedInteger, calculateLine, MAX_CENTS, sumLines } from '../../../../packages/domain/src/money.js'

export const ordersRouter = Router()
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

export function validateOperation(raw: unknown) {
  const body = record(raw, 'Operation')
  const order = record(body.order, 'Order')
  const payment = record(body.payment, 'Payment')
  const items = body.items
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw new ApiError(422, 'validation_failed', 'An order needs 1 to 100 items.')
  const storeId = id(order.store_id, 'Store ID')
  const operationId = id(body.operation_id, 'Operation ID')
  if (operationId !== id(order.id, 'Order ID')) throw new ApiError(422, 'validation_failed', 'Order ID must match operation ID.')
  const parsedItems = items.map((rawItem, index) => {
    const item = record(rawItem, `Item ${index + 1}`)
    if (!Number.isSafeInteger(item.catalog_version) || (item.catalog_version as number) < 1 || (item.catalog_version as number) > MAX_CENTS) {
      throw new ApiError(422, 'validation_failed', `Item ${index + 1} catalog version is invalid.`)
    }
    const price = cents(item.snapshot_price_cents, 'Unit price')
    let line: ReturnType<typeof calculateLine>
    try { line = calculateLine(price, item.quantity as number, item.snapshot_tax_bps as number) }
    catch { throw new ApiError(422, 'validation_failed', `Item ${index + 1} has invalid quantity, tax or amount.`) }
    if (line.subtotalCents !== item.subtotal_cents || line.taxCents !== item.tax_cents || line.totalCents !== item.total_cents) {
      throw new ApiError(422, 'total_mismatch', `Item ${index + 1} totals do not match.`)
    }
    return { id: id(item.id, 'Item ID'), product_id: id(item.product_id, 'Product ID'),
      snapshot_name: text(item.snapshot_name, 'Item name'), snapshot_sku: text(item.snapshot_sku, 'Item SKU', 80),
      snapshot_price_cents: price, snapshot_tax_bps: item.snapshot_tax_bps as number,
      catalog_version: item.catalog_version as number,
      quantity: item.quantity as number, ...{ subtotal_cents: line.subtotalCents, tax_cents: line.taxCents, total_cents: line.totalCents } }
  })
  let totals: ReturnType<typeof sumLines>
  try { totals = sumLines(parsedItems.map(item => ({ subtotalCents: item.subtotal_cents, taxCents: item.tax_cents, totalCents: item.total_cents }))) }
  catch { throw new ApiError(422, 'total_mismatch', 'Order exceeds the supported money range.') }
  if (totals.subtotalCents !== order.subtotal_cents || totals.taxCents !== order.tax_cents || totals.totalCents !== order.total_cents) {
    throw new ApiError(422, 'total_mismatch', 'Order totals do not match line totals.')
  }
  const method = payment.method
  if (method !== 'cash' && method !== 'card') throw new ApiError(422, 'validation_failed', 'Payment method is invalid.')
  const amount = cents(payment.amount_cents, 'Payment amount')
  const tendered = cents(payment.tendered_cents, 'Tendered amount')
  const change = cents(payment.change_cents, 'Change amount')
  if (amount !== totals.totalCents || (method === 'cash' && tendered !== amount + change) ||
      (method === 'card' && (tendered !== amount || change !== 0))) {
    throw new ApiError(422, 'total_mismatch', 'Payment does not balance with the order.')
  }
  const generatedAt = text(order.client_generated_at, 'Sale time', 40)
  if (Number.isNaN(Date.parse(generatedAt))) throw new ApiError(422, 'validation_failed', 'Sale time is invalid.')
  if (!Number.isSafeInteger(order.catalog_version) || (order.catalog_version as number) < 1 || (order.catalog_version as number) > MAX_CENTS) {
    throw new ApiError(422, 'validation_failed', 'Catalog version is invalid.')
  }
  return { operationId, storeId, items: parsedItems, totals,
    order: { receipt_number: text(order.receipt_number, 'Receipt number', 100),
      catalog_version: order.catalog_version as number,
      client_generated_at: generatedAt },
    payment: { id: id(payment.id, 'Payment ID'), method, amount_cents: amount,
      tendered_cents: tendered, change_cents: change,
      reference: payment.reference === null || payment.reference === undefined ? null : text(payment.reference, 'Card reference', 120) } }
}

ordersRouter.post('/push', async (req, res) => {
  try {
    const operation = validateOperation(req.body)
    await requireStoreMember(req, operation.storeId)
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
      const store = await client.query('select name,timezone,currency from public.stores where id=$1', [operation.storeId])
      if (!store.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Store no longer exists.')
      const productIds = [...new Set(operation.items.map(item => item.product_id))]
      const products = await client.query('select id from public.pos_products where store_id=$1 and id = any($2::uuid[])', [operation.storeId, productIds])
      if (products.rowCount !== productIds.length) throw new ApiError(422, 'cross_store_reference', 'An item refers to a product outside this store.')
      await client.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,tax_cents,total_cents,catalog_version,client_generated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [operation.operationId, operation.storeId, operation.order.receipt_number, store.rows[0].currency,
          store.rows[0].name, store.rows[0].timezone, operation.totals.subtotalCents, operation.totals.taxCents,
          operation.totals.totalCents, operation.order.catalog_version, operation.order.client_generated_at])
      for (const item of operation.items) {
        await client.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
          snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,tax_cents,total_cents)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [item.id, operation.storeId, operation.operationId, item.product_id, item.snapshot_name, item.snapshot_sku,
            item.snapshot_price_cents, item.snapshot_tax_bps, item.catalog_version, item.quantity, item.subtotal_cents, item.tax_cents, item.total_cents])
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
          where store_id=$1 and product_id=$2 returning current_stock`, [operation.storeId, productId, quantity])
        if (!stock.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Stock projection is missing for a product.')
        position += 1n
        await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
          values ($1,$2,'stock',$3,$4)`, [operation.storeId, position.toString(), productId, { product_id: productId, current_stock: stock.rows[0].current_stock }])
      }
      position += 1n
      await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
        values ($1,$2,'order',$3,$4)`, [operation.storeId, position.toString(), operation.operationId, { receipt_number: operation.order.receipt_number }])
      await client.query('update public.pos_sync_feed_state set last_position=$2 where store_id=$1', [operation.storeId, position.toString()])
      const result = { status: 'accepted', operation_id: operation.operationId, accepted_checkpoint: position.toString() }
      await client.query(`insert into public.pos_operation_ledger(store_id,operation_id,payload_hash,status,result_json,accepted_checkpoint)
        values ($1,$2,$3,'accepted',$4,$5)`, [operation.storeId, operation.operationId, hash, result, position.toString()])
      await client.query('commit')
      res.json(result)
    } catch (reason) { await client.query('rollback'); throw reason }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
})
