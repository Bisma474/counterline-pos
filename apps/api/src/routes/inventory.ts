import { createHash } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { ApiError, requireStoreManager, sendApiError } from './auth.js'
import { inventoryStatus, lockStockableForUpdate, productStockable, type InventoryStatus } from '../lib/stockable.js'

export const inventoryRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ADJUSTMENT_REASONS = ['damaged', 'expired', 'lost', 'received', 'correction', 'other'] as const
type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]

function uuid(value: unknown, name: string): string {
  const s = String(value ?? '')
  if (!UUID_RE.test(s)) throw new ApiError(400, 'validation_failed', `A valid ${name} is required.`)
  return s
}
function storeIdParam(req: Request): string {
  return uuid(req.query.store_id, 'store_id')
}
function storeIdBody(body: Record<string, unknown>): string {
  return uuid(body.store_id, 'store_id')
}

/** Same action.verb / short descriptive target convention as terminal-auth's audit() helper —
 * duplicated per-file rather than shared, matching this codebase's existing convention
 * (see apps/api/src/routes/audit.ts's own comment on the same choice). */
async function audit(client: PoolClient, storeId: string, actorId: string, action: string, target: string): Promise<void> {
  await client.query('insert into public.audit_log(store_id, actor_id, action, target) values ($1,$2,$3,$4)', [storeId, actorId, action, target])
}

/** audit_log.target is capped at 200 characters; pos_products allows a 160-char name plus an
 * 80-char SKU, which together with the rest of an audit target's fixed text can exceed that limit
 * and fail the whole transaction's CHECK constraint. Truncate the two variable-length pieces
 * before building a target string so a long product name can never wedge an adjustment or a
 * cycle-count submit. */
function truncateForAudit(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Locks the store's sync-feed row for the rest of this transaction and returns its current
 * position, matching push()/refund()/createProduct()'s own lock-once-then-increment-in-memory
 * pattern exactly: callers bump the returned value locally per change_feed row they write, and
 * persist the final value with a single `advanceFeed` call before commit. Locking first — before
 * any product/stock row lock — keeps every write path's lock order consistent so a manual
 * adjustment, a cycle-count submit and a checkout can never deadlock against each other. */
async function lockFeedPosition(client: PoolClient, storeId: string): Promise<bigint> {
  const feed = await client.query<{ last_position: string }>('select last_position::text as last_position from public.pos_sync_feed_state where store_id=$1 for update', [storeId])
  if (!feed.rows[0]) throw new ApiError(503, 'server_unavailable', 'Store is not initialized.')
  return BigInt(feed.rows[0].last_position)
}
async function writeStockFeedEntry(client: PoolClient, storeId: string, position: bigint, productId: string, currentStock: number): Promise<void> {
  await client.query(
    `insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload) values ($1,$2,'stock',$3,$4)`,
    [storeId, position.toString(), productId, { product_id: productId, current_stock: currentStock }],
  )
}
async function advanceFeed(client: PoolClient, storeId: string, position: bigint): Promise<void> {
  await client.query('update public.pos_sync_feed_state set last_position=$2 where store_id=$1', [storeId, position.toString()])
}

// ---------------------------------------------------------------------------
// GET /inventory — list every product in the store with authoritative stock, threshold, and status.
// Owner/manager only, matching the Inventory screen's own scope.
// ---------------------------------------------------------------------------
export interface InventoryRow {
  product_id: string
  name: string
  sku: string
  barcode: string | null
  category_id: string | null
  category_name: string | null
  unit_price_cents: string
  current_stock: number
  low_stock_threshold: number
  status: InventoryStatus
}

async function listInventory(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const result = await db.query<Omit<InventoryRow, 'status'>>(
      `select p.id as product_id, p.name, p.sku, p.barcode, p.category_id, c.name as category_name,
              p.unit_price_cents::text as unit_price_cents, p.low_stock_threshold,
              coalesce(s.current_stock, 0) as current_stock
       from public.pos_products p
       left join public.pos_categories c on c.store_id = p.store_id and c.id = p.category_id
       left join public.pos_stock s on s.store_id = p.store_id and s.product_id = p.id
       where p.store_id = $1
       order by p.name`,
      [storeId],
    )
    const rows: InventoryRow[] = result.rows.map(row => ({ ...row, status: inventoryStatus(row.current_stock, row.low_stock_threshold) }))
    res.json({ items: rows })
  } catch (reason) { sendApiError(res, reason) }
}

// ---------------------------------------------------------------------------
// GET /inventory/movements — the ledger, store-wide or filtered to one product.
// ---------------------------------------------------------------------------
export interface MovementRow {
  id: string
  product_id: string
  product_name: string | null
  delta: number
  reason: string
  adjustment_reason: string | null
  note: string | null
  old_quantity: number | null
  new_quantity: number | null
  actor_name: string | null
  cycle_count_id: string | null
  server_received_at: string
}

async function listMovements(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const productId = req.query.product_id !== undefined ? uuid(req.query.product_id, 'product_id') : null
    const rawLimit = Number(req.query.limit ?? 50)
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 200 ? rawLimit : 50
    const result = await db.query<MovementRow>(
      `select m.id, m.product_id, p.name as product_name, m.delta, m.reason, m.adjustment_reason, m.note,
              m.old_quantity, m.new_quantity, pr.full_name as actor_name, m.cycle_count_id,
              m.server_received_at
       from public.pos_inventory_movements m
       left join public.pos_products p on p.store_id = m.store_id and p.id = m.product_id
       left join public.profiles pr on pr.id = m.actor_id
       where m.store_id = $1 and ($2::uuid is null or m.product_id = $2)
       order by m.server_received_at desc, m.id desc
       limit $3`,
      [storeId, productId, limit],
    )
    res.json({ items: result.rows })
  } catch (reason) { sendApiError(res, reason) }
}

// ---------------------------------------------------------------------------
// PATCH /inventory/threshold — update one product's configurable low-stock threshold.
// Not a stock-changing action (no movement/change-feed entry), but still audited.
// ---------------------------------------------------------------------------
async function updateThreshold(req: Request, res: Response) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = storeIdBody(body)
    const productId = uuid(body.product_id, 'product_id')
    const rawThreshold = body.low_stock_threshold
    if (!Number.isInteger(rawThreshold) || (rawThreshold as number) < 0 || (rawThreshold as number) > 1_000_000) {
      throw new ApiError(422, 'validation_failed', 'low_stock_threshold must be a non-negative integer.')
    }
    const threshold = rawThreshold as number
    const actorId = await requireStoreManager(req, storeId)

    const client = await db.connect()
    try {
      await client.query('begin')
      const result = await client.query<{ name: string }>(
        'update public.pos_products set low_stock_threshold=$1 where store_id=$2 and id=$3 returning name',
        [threshold, storeId, productId],
      )
      if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Product not found in this store.')
      await audit(client, storeId, actorId, 'inventory.threshold_updated', `${truncateForAudit(result.rows[0].name, 60)}: low-stock threshold set to ${threshold}`)
      await client.query('commit')
      res.json({ product_id: productId, low_stock_threshold: threshold })
    } catch (reason) {
      await client.query('rollback')
      throw reason
    } finally {
      client.release()
    }
  } catch (reason) { sendApiError(res, reason) }
}

// ---------------------------------------------------------------------------
// POST /inventory/adjust — manual stock adjustment. One transaction, the full 12-step sequence:
// authenticate -> authorize -> scope -> resolve+lock stock -> validate -> compute -> movement ->
// update stock -> audit -> change feed -> commit. Any failure rolls back everything.
// ---------------------------------------------------------------------------
export interface AdjustResult {
  product_id: string
  old_quantity: number
  new_quantity: number
  delta: number
  movement_id: string
}

async function adjustStock(req: Request, res: Response) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = storeIdBody(body)
    // A client-supplied idempotency key: a lost response (proxy timeout, dropped connection) must
    // not turn a retried "Save" click into a second, silently-doubled stock movement. Reuses the
    // same pos_operation_ledger replay mechanism orders.ts's push() already relies on for exactly
    // this reason — the server-generated operation_id this endpoint used before this fix could
    // never collide with itself, so a retry always applied the delta a second time.
    const operationId = uuid(body.operation_id, 'operation_id')
    const productId = uuid(body.product_id, 'product_id')
    const rawDelta = body.delta
    if (!Number.isInteger(rawDelta) || rawDelta === 0 || Math.abs(rawDelta as number) > 1_000_000) {
      throw new ApiError(422, 'validation_failed', 'delta must be a non-zero integer (magnitude up to 1,000,000).')
    }
    const delta = rawDelta as number
    const reasonCode = String(body.reason ?? '')
    if (!ADJUSTMENT_REASONS.includes(reasonCode as AdjustmentReason)) {
      throw new ApiError(422, 'validation_failed', `reason must be one of: ${ADJUSTMENT_REASONS.join(', ')}.`)
    }
    const note = String(body.note ?? '').trim()
    if (!note) throw new ApiError(422, 'validation_failed', 'A note is required for every manual adjustment.')
    if (note.length > 500) throw new ApiError(422, 'validation_failed', 'Note must be 500 characters or fewer.')
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')

    // 1+2: authenticate + authorize (owner/manager). 3: store scope is storeId itself, verified below.
    const actorId = await requireStoreManager(req, storeId)

    const client = await db.connect()
    try {
      await client.query('begin')
      // Lock the feed row first — every write path in this codebase serializes per-store writes
      // through it, so this also protects against a concurrent adjust/checkout/cycle-count racing
      // on the same store's stock rows in a different lock order. It also serializes two
      // concurrent identical retries, so the replay check below never races itself.
      let position = await lockFeedPosition(client, storeId)
      const replay = await client.query<{ payload_hash: string; result_json: AdjustResult }>(
        'select payload_hash, result_json from public.pos_operation_ledger where store_id=$1 and operation_id=$2',
        [storeId, operationId],
      )
      if (replay.rows[0]) {
        if (replay.rows[0].payload_hash !== hash) throw new ApiError(409, 'operation_id_conflict', 'This operation ID was already used for a different adjustment.')
        await client.query('commit')
        res.json(replay.rows[0].result_json)
        return
      }
      // 4+5: resolve and lock the authoritative stock row.
      const stockable = await lockStockableForUpdate(client, storeId, productStockable(productId))
      if (!stockable) throw new ApiError(422, 'cross_store_reference', 'Product not found in this store.')
      // 6+7: validate the operation, compute old -> new. Never clamp — negative stock is valid.
      const oldQuantity = stockable.current_stock
      const newQuantity = oldQuantity + delta
      // 8: immutable movement row.
      const movement = await client.query<{ id: string }>(
        `insert into public.pos_inventory_movements
          (store_id, product_id, operation_id, delta, reason, adjustment_reason, note, actor_id, old_quantity, new_quantity)
         values ($1,$2,gen_random_uuid(),$3,'manual_adjustment',$4,$5,$6,$7,$8)
         returning id`,
        [storeId, productId, delta, reasonCode, note, actorId, oldQuantity, newQuantity],
      )
      const movementId = movement.rows[0].id
      // 9: update authoritative stock.
      await client.query('update public.pos_stock set current_stock=$1, updated_at=now() where store_id=$2 and product_id=$3', [newQuantity, storeId, productId])
      // 10: audit.
      await audit(client, storeId, actorId, 'inventory.adjusted', `${truncateForAudit(stockable.name, 60)} (${truncateForAudit(stockable.sku, 30)}): ${oldQuantity} → ${newQuantity} (${delta > 0 ? '+' : ''}${delta}, ${reasonCode})`)
      // 11: change feed.
      position += 1n
      await writeStockFeedEntry(client, storeId, position, productId, newQuantity)
      await advanceFeed(client, storeId, position)
      const result: AdjustResult = { product_id: productId, old_quantity: oldQuantity, new_quantity: newQuantity, delta, movement_id: movementId }
      await client.query(
        `insert into public.pos_operation_ledger(store_id,operation_id,payload_hash,status,result_json,accepted_checkpoint)
         values ($1,$2,$3,'accepted',$4,$5)`,
        [storeId, operationId, hash, result, position.toString()],
      )
      // 12: commit.
      await client.query('commit')
      res.status(201).json(result)
    } catch (reason) {
      await client.query('rollback')
      throw reason
    } finally {
      client.release()
    }
  } catch (reason) { sendApiError(res, reason) }
}

// ---------------------------------------------------------------------------
// Cycle counts.
// ---------------------------------------------------------------------------
export interface CycleCountItem { id: string; product_id: string; product_name: string; sku: string; expected_quantity: number; counted_quantity: number | null; counted_at: string | null }
export interface CycleCountSession { id: string; status: 'open' | 'submitted' | 'cancelled'; started_at: string; submitted_at: string | null; note: string | null; items: CycleCountItem[] }

async function loadSession(storeId: string, cycleCountId: string): Promise<CycleCountSession | null> {
  const session = await db.query<{ id: string; status: 'open' | 'submitted' | 'cancelled'; started_at: string; submitted_at: string | null; note: string | null }>(
    'select id, status, started_at, submitted_at, note from public.pos_cycle_counts where store_id=$1 and id=$2',
    [storeId, cycleCountId],
  )
  if (!session.rows[0]) return null
  const items = await db.query<CycleCountItem>(
    `select i.id, i.product_id, p.name as product_name, p.sku, i.expected_quantity, i.counted_quantity, i.counted_at
     from public.pos_cycle_count_items i
     join public.pos_products p on p.store_id = i.store_id and p.id = i.product_id
     where i.cycle_count_id = $1
     order by p.name`,
    [cycleCountId],
  )
  return { ...session.rows[0], items: items.rows }
}

// POST /inventory/cycle-counts — start a session over a chosen set of products, snapshotting
// today's stock as the expected quantity shown while counting is in progress.
async function createCycleCount(req: Request, res: Response) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = storeIdBody(body)
    const productIds = body.product_ids
    if (!Array.isArray(productIds) || productIds.length < 1 || productIds.length > 500) {
      throw new ApiError(422, 'validation_failed', 'Select 1 to 500 products to count.')
    }
    const ids = productIds.map(value => uuid(value, 'product_id'))
    if (new Set(ids).size !== ids.length) throw new ApiError(422, 'validation_failed', 'Duplicate products in the selection.')
    const note = body.note !== undefined && body.note !== null && String(body.note).trim() !== '' ? String(body.note).trim().slice(0, 500) : null

    const actorId = await requireStoreManager(req, storeId)

    const client = await db.connect()
    let sessionId = ''
    try {
      await client.query('begin')
      const products = await client.query<{ id: string }>('select id from public.pos_products where store_id=$1 and id = any($2::uuid[])', [storeId, ids])
      if (products.rowCount !== ids.length) throw new ApiError(422, 'cross_store_reference', 'A selected product does not belong to this store.')
      const created = await client.query<{ id: string }>(
        "insert into public.pos_cycle_counts(store_id, status, started_by, note) values ($1,'open',$2,$3) returning id",
        [storeId, actorId, note],
      )
      sessionId = created.rows[0].id
      // Snapshot current authoritative stock as the display-only "expected" figure. Not locked —
      // this is a point-in-time read for the counter's convenience, never the value trusted at
      // submit time (submit re-locks and re-reads pos_stock fresh; see submitCycleCount below).
      const stock = await client.query<{ product_id: string; current_stock: number }>(
        'select product_id, current_stock from public.pos_stock where store_id=$1 and product_id = any($2::uuid[])',
        [storeId, ids],
      )
      const stockMap = new Map(stock.rows.map(row => [row.product_id, row.current_stock]))
      for (const productId of ids) {
        await client.query(
          'insert into public.pos_cycle_count_items(cycle_count_id, store_id, product_id, expected_quantity) values ($1,$2,$3,$4)',
          [sessionId, storeId, productId, stockMap.get(productId) ?? 0],
        )
      }
      await audit(client, storeId, actorId, 'inventory.cycle_count_started', `${ids.length} product${ids.length === 1 ? '' : 's'}`)
      await client.query('commit')
    } catch (reason) {
      await client.query('rollback')
      throw reason
    } finally {
      client.release()
    }
    res.status(201).json(await loadSession(storeId, sessionId))
  } catch (reason) { sendApiError(res, reason) }
}

async function getCycleCount(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const session = await loadSession(storeId, uuid(req.params.id, 'cycle count id'))
    if (!session) throw new ApiError(404, 'not_found', 'Cycle count session not found.')
    res.json(session)
  } catch (reason) { sendApiError(res, reason) }
}

// PATCH /inventory/cycle-counts/:id/items/:itemId — record one counted quantity. No stock
// mutation happens here; this only lets the UI preview variance before submission.
async function recordCount(req: Request, res: Response) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = storeIdBody(body)
    const cycleCountId = uuid(req.params.id, 'cycle count id')
    const itemId = uuid(req.params.itemId, 'item id')
    const rawCounted = body.counted_quantity
    if (!Number.isInteger(rawCounted) || (rawCounted as number) < 0 || (rawCounted as number) > 100_000_000) {
      throw new ApiError(422, 'validation_failed', 'counted_quantity must be a non-negative integer.')
    }
    await requireStoreManager(req, storeId)
    const result = await db.query<{ expected_quantity: number }>(
      `update public.pos_cycle_count_items i set counted_quantity=$1, counted_at=now()
       from public.pos_cycle_counts c
       where i.id=$2 and i.cycle_count_id=$3 and i.store_id=$4 and c.id=i.cycle_count_id and c.status='open'
       returning i.expected_quantity`,
      [rawCounted, itemId, cycleCountId, storeId],
    )
    if (!result.rows[0]) throw new ApiError(409, 'cycle_count_not_open', 'This count is not open (not found, or already submitted/cancelled).')
    res.json({ item_id: itemId, counted_quantity: rawCounted, expected_quantity: result.rows[0].expected_quantity, variance_preview: (rawCounted as number) - result.rows[0].expected_quantity })
  } catch (reason) { sendApiError(res, reason) }
}

// POST /inventory/cycle-counts/:id/submit — one transaction. Re-locks live stock per counted item
// (never the stale expected_quantity snapshot) and only writes a movement where variance != 0.
export interface SubmitResult { adjusted: AdjustResult[]; unchanged_count: number }

async function submitCycleCount(req: Request, res: Response) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = storeIdBody(body)
    const cycleCountId = uuid(req.params.id, 'cycle count id')
    const actorId = await requireStoreManager(req, storeId)

    const client = await db.connect()
    try {
      await client.query('begin')
      const session = await client.query<{ id: string; note: string | null }>(
        "select id, note from public.pos_cycle_counts where store_id=$1 and id=$2 and status='open' for update",
        [storeId, cycleCountId],
      )
      if (!session.rows[0]) throw new ApiError(409, 'cycle_count_not_open', 'This count is not open (not found, or already submitted/cancelled).')

      // Locking these rows for the rest of the transaction closes a race against a concurrent
      // PATCH .../items/:itemId: that handler's UPDATE would otherwise be free to land on a row
      // already read here, after which its edit would be silently excluded from this submit yet
      // still visible on the (by-then-submitted) item — locking makes it block until this
      // transaction ends, then correctly fail with cycle_count_not_open instead.
      const items = await client.query<{ id: string; product_id: string; counted_quantity: number | null }>(
        'select id, product_id, counted_quantity from public.pos_cycle_count_items where cycle_count_id=$1 and counted_quantity is not null order by product_id for update',
        [cycleCountId],
      )
      if (!items.rowCount) throw new ApiError(422, 'validation_failed', 'Count at least one product before submitting.')

      // Lock the feed row before touching any stock row (see lockFeedPosition's comment) — items
      // are already sorted by product_id above, so this loop always locks stock rows in the same
      // global order as every other multi-row locker, avoiding cross-transaction deadlocks.
      let position = await lockFeedPosition(client, storeId)
      const adjusted: AdjustResult[] = []
      let unchangedCount = 0
      for (const item of items.rows) {
        const stockable = await lockStockableForUpdate(client, storeId, productStockable(item.product_id))
        if (!stockable) throw new ApiError(422, 'cross_store_reference', 'A counted product no longer belongs to this store.')
        const liveQuantity = stockable.current_stock
        const counted = item.counted_quantity as number
        const variance = counted - liveQuantity
        if (variance === 0) { unchangedCount += 1; continue }
        const movement = await client.query<{ id: string }>(
          `insert into public.pos_inventory_movements
            (store_id, product_id, operation_id, delta, reason, note, actor_id, old_quantity, new_quantity, cycle_count_id)
           values ($1,$2,gen_random_uuid(),$3,'cycle_count',$4,$5,$6,$7,$8)
           returning id`,
          [storeId, item.product_id, variance, session.rows[0].note, actorId, liveQuantity, counted, cycleCountId],
        )
        await client.query('update public.pos_stock set current_stock=$1, updated_at=now() where store_id=$2 and product_id=$3', [counted, storeId, item.product_id])
        await audit(client, storeId, actorId, 'inventory.cycle_count_variance', `${truncateForAudit(stockable.name, 60)} (${truncateForAudit(stockable.sku, 30)}): ${liveQuantity} → ${counted} (${variance > 0 ? '+' : ''}${variance})`)
        position += 1n
        await writeStockFeedEntry(client, storeId, position, item.product_id, counted)
        adjusted.push({ product_id: item.product_id, old_quantity: liveQuantity, new_quantity: counted, delta: variance, movement_id: movement.rows[0].id })
      }
      if (adjusted.length > 0) await advanceFeed(client, storeId, position)

      await client.query("update public.pos_cycle_counts set status='submitted', submitted_by=$1, submitted_at=now() where id=$2", [actorId, cycleCountId])
      await audit(client, storeId, actorId, 'inventory.cycle_count_submitted', `${adjusted.length} adjusted, ${unchangedCount} unchanged`)
      await client.query('commit')
      const result: SubmitResult = { adjusted, unchanged_count: unchangedCount }
      res.json(result)
    } catch (reason) {
      await client.query('rollback')
      throw reason
    } finally {
      client.release()
    }
  } catch (reason) { sendApiError(res, reason) }
}

async function cancelCycleCount(req: Request, res: Response) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = storeIdBody(body)
    const cycleCountId = uuid(req.params.id, 'cycle count id')
    const actorId = await requireStoreManager(req, storeId)
    const client = await db.connect()
    try {
      await client.query('begin')
      const result = await client.query(
        "update public.pos_cycle_counts set status='cancelled' where store_id=$1 and id=$2 and status='open' returning id",
        [storeId, cycleCountId],
      )
      if (!result.rowCount) throw new ApiError(409, 'cycle_count_not_open', 'This count is not open (not found, or already submitted/cancelled).')
      await audit(client, storeId, actorId, 'inventory.cycle_count_cancelled', cycleCountId)
      await client.query('commit')
      res.json({ id: cycleCountId, status: 'cancelled' })
    } catch (reason) {
      await client.query('rollback')
      throw reason
    } finally {
      client.release()
    }
  } catch (reason) { sendApiError(res, reason) }
}

inventoryRouter.get('/inventory', (req, res) => void listInventory(req, res))
inventoryRouter.get('/inventory/movements', (req, res) => void listMovements(req, res))
inventoryRouter.patch('/inventory/threshold', (req, res) => void updateThreshold(req, res))
inventoryRouter.post('/inventory/adjust', (req, res) => void adjustStock(req, res))
inventoryRouter.post('/inventory/cycle-counts', (req, res) => void createCycleCount(req, res))
inventoryRouter.get('/inventory/cycle-counts/:id', (req, res) => void getCycleCount(req, res))
inventoryRouter.patch('/inventory/cycle-counts/:id/items/:itemId', (req, res) => void recordCount(req, res))
inventoryRouter.post('/inventory/cycle-counts/:id/submit', (req, res) => void submitCycleCount(req, res))
inventoryRouter.post('/inventory/cycle-counts/:id/cancel', (req, res) => void cancelCycleCount(req, res))
