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
