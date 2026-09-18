import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { ApiError, requireStoreMember, sendApiError } from './auth.js'
import { calendarDayBoundsUtc } from '../lib/timezone.js'

export const reportsRouter = Router()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const dateRe = /^\d{4}-\d{2}-\d{2}$/

export async function requireReportAccess(req: Request, storeId: string): Promise<void> {
  const userId = await requireStoreMember(req, storeId)
  const result = await db.query<{ role: string }>('select role from public.store_memberships where store_id=$1 and user_id=$2 and active=true', [storeId, userId])
  if (!['owner', 'manager'].includes(result.rows[0]?.role ?? '')) throw new ApiError(403, 'authorization_failed', 'Report access requires an owner or manager role.')
}

export function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!uuid.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}

export function dateParam(req: Request): string {
  const date = String(req.query.date ?? '')
  if (!dateRe.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) throw new ApiError(400, 'validation_failed', 'A valid date (YYYY-MM-DD) is required.')
  return date
}

async function storeTimezone(storeId: string): Promise<string> {
  const store = await db.query<{ timezone: string }>('select timezone from public.stores where id=$1', [storeId])
  if (!store.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Store no longer exists.')
  return store.rows[0].timezone
}

async function dayBounds(storeId: string, date: string) {
  const timezone = await storeTimezone(storeId)
  return calendarDayBoundsUtc(date, timezone)
}

export interface DailySummary {
  grossSalesCents: number
  discountCents: number
  netSalesCents: number
  taxCents: number
  cashTakingsCents: number
  cardTakingsCents: number
  recordedTotalCents: number
  completedOrderCount: number
  averageSaleCents: number
  itemsSold: number
}

// Field names match LocalSalesReport in apps/web/src/lib/reporting.ts so the frontend can consume
// either shape uniformly. No pending/rejected fields: server data is only ever accepted orders — a
// rejected sale never reaches pos_orders at all, since the API only accepts fully-valid operations.
export async function loadDailySummary(storeId: string, date: string): Promise<DailySummary> {
  const { startUtc, endUtc } = await dayBounds(storeId, date)
  const totals = await db.query<{ gross: string; discount: string; tax: string; total: string; count: string }>(`
    select coalesce(sum(subtotal_cents),0)::text as gross, coalesce(sum(discount_cents),0)::text as discount,
      coalesce(sum(tax_cents),0)::text as tax, coalesce(sum(total_cents),0)::text as total, count(*)::text as count
    from public.pos_orders where store_id=$1 and client_generated_at >= $2 and client_generated_at < $3`,
    [storeId, startUtc, endUtc])
  const items = await db.query<{ qty: string }>(`
    select coalesce(sum(oi.quantity),0)::text as qty from public.pos_order_items oi
    join public.pos_orders o on o.store_id=oi.store_id and o.id=oi.order_id
    where o.store_id=$1 and o.client_generated_at >= $2 and o.client_generated_at < $3`,
    [storeId, startUtc, endUtc])
  const payments = await db.query<{ method: string; amount: string }>(`
    select p.method, coalesce(sum(p.amount_cents),0)::text as amount from public.pos_payments p
    join public.pos_orders o on o.store_id=p.store_id and o.id=p.order_id
    where o.store_id=$1 and o.client_generated_at >= $2 and o.client_generated_at < $3
    group by p.method`, [storeId, startUtc, endUtc])
  const row = totals.rows[0]
  const grossSalesCents = Number(row.gross), discountCents = Number(row.discount), taxCents = Number(row.tax)
  const recordedTotalCents = Number(row.total), completedOrderCount = Number(row.count)
  const cashTakingsCents = Number(payments.rows.find(p => p.method === 'cash')?.amount ?? '0')
  const cardTakingsCents = Number(payments.rows.find(p => p.method === 'card')?.amount ?? '0')
  const averageSaleCents = completedOrderCount
    ? Math.floor((recordedTotalCents + Math.floor(completedOrderCount / 2)) / completedOrderCount)
    : 0
  return { grossSalesCents, discountCents, netSalesCents: grossSalesCents - discountCents, taxCents,
    cashTakingsCents, cardTakingsCents, recordedTotalCents, completedOrderCount, averageSaleCents,
    itemsSold: Number(items.rows[0]?.qty ?? '0') }
}

async function dailySummaryHandler(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireReportAccess(req, storeId)
    const date = dateParam(req)
    res.json(await loadDailySummary(storeId, date))
  } catch (reason) { sendApiError(res, reason) }
}
reportsRouter.get('/daily-summary', (req, res) => void dailySummaryHandler(req, res))

export interface ReportOrderSummary {
  id: string
  receiptNumber: string
  time: string
  totalCents: number
  paymentMethod: 'cash' | 'card' | 'unknown'
  itemCount: number
  syncStatus: 'synced'
  employeeId: string | null
  cashierName: string | null
}
export interface OrdersPage { orders: ReportOrderSummary[]; next_cursor: string | null }

function cursorParam(req: Request): { id: string } | null {
  const value = req.query.cursor
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length > 160) throw new ApiError(400, 'validation_failed', 'Invalid cursor.')
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw new ApiError(400, 'validation_failed', 'Invalid cursor.') }
  const id = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).id : undefined
  if (typeof id !== 'string' || !uuid.test(id)) throw new ApiError(400, 'validation_failed', 'Invalid cursor.')
  return { id }
}
function limitParam(req: Request): number {
  const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit)
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) throw new ApiError(400, 'validation_failed', 'Limit must be 1 to 200.')
  return rawLimit
}

// Cross-device drill-down for a store's calendar day, mirroring the exact cursor pattern in
// customers.ts's cursor()/search(): base64url-encoded {id} cursor, id > $cursor keyset pagination,
// limit+1 fetch to compute next_cursor cheaply.
export async function loadOrdersPage(storeId: string, date: string, cursorId: string | null, limit: number): Promise<OrdersPage> {
  const { startUtc, endUtc } = await dayBounds(storeId, date)
  const result = await db.query<{
    id: string; receipt_number: string; client_generated_at: string; total_cents: string
    payment_method: string | null; item_count: string; employee_id: string | null; cashier_name: string | null
  }>(`
    select o.id, o.receipt_number, o.client_generated_at, o.total_cents::text as total_cents,
      p.method as payment_method, coalesce(oi.qty, 0)::text as item_count,
      o.employee_id, e.name as cashier_name
    from public.pos_orders o
    left join public.pos_payments p on p.store_id = o.store_id and p.order_id = o.id
    left join (select order_id, sum(quantity) as qty from public.pos_order_items where store_id=$1 group by order_id) oi
      on oi.order_id = o.id
    left join public.terminal_employees e on e.store_id = o.store_id and e.id = o.employee_id
    where o.store_id = $1 and o.client_generated_at >= $2 and o.client_generated_at < $3
      and ($4::uuid is null or o.id > $4::uuid)
    order by o.id limit $5`,
    [storeId, startUtc, endUtc, cursorId, limit + 1])
  const page = result.rows.slice(0, limit)
  const last = page.at(-1)
  return {
    orders: page.map(row => ({
      id: row.id, receiptNumber: row.receipt_number, time: row.client_generated_at,
      totalCents: Number(row.total_cents), paymentMethod: (row.payment_method as 'cash' | 'card' | null) ?? 'unknown',
      itemCount: Number(row.item_count), syncStatus: 'synced',
      employeeId: row.employee_id, cashierName: row.cashier_name,
    })),
    next_cursor: result.rows.length > limit && last ? Buffer.from(JSON.stringify({ id: last.id })).toString('base64url') : null,
  }
}

async function ordersHandler(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireReportAccess(req, storeId)
    const date = dateParam(req)
    const limit = limitParam(req)
    const cursor = cursorParam(req)
    res.json(await loadOrdersPage(storeId, date, cursor?.id ?? null, limit))
  } catch (reason) { sendApiError(res, reason) }
}
reportsRouter.get('/orders', (req, res) => void ordersHandler(req, res))
