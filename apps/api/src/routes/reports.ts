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
