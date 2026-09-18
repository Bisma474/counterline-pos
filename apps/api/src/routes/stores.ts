import { Router } from 'express'
import { db } from '../db.js'
import { requireStoreMember, requireStoreManager, sendApiError, ApiError } from './auth.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function getStore(req: import('express').Request, res: import('express').Response) {
  try {
    const storeId = String(req.params.id ?? '')
    if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store ID is required.')
    await requireStoreMember(req, storeId)
    const result = await db.query(
      'select id, name, timezone, currency, address, country from public.stores where id=$1',
      [storeId],
    )
    if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Store not found.')
    res.json(result.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

// ---------------------------------------------------------------------------
// PATCH /stores/:id — owner/manager edits business details.
// Partial update: only fields present in the body are changed. name is deliberately
// not editable here — it is set at store creation and not part of this task's scope.
// ---------------------------------------------------------------------------
async function patchStore(req: import('express').Request, res: import('express').Response) {
  try {
    const storeId = String(req.params.id ?? '')
    if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store ID is required.')
    await requireStoreManager(req, storeId)
    const body = req.body as Record<string, unknown>

    const updates: string[] = []
    const values: unknown[] = []
    let index = 1

    if (body.currency !== undefined) {
      const currency = String(body.currency).trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError(422, 'validation_failed', 'Currency must be a three-letter ISO code.')
      updates.push(`currency = $${index++}`); values.push(currency)
    }
    if (body.timezone !== undefined) {
      const timezone = String(body.timezone).trim()
      if (!timezone) throw new ApiError(422, 'validation_failed', 'Timezone is required.')
      try { await db.query('select timezone($1, now())', [timezone]) }
      catch { throw new ApiError(422, 'validation_failed', 'Timezone is not a recognized zone name.') }
      updates.push(`timezone = $${index++}`); values.push(timezone)
    }
    if (body.address !== undefined) {
      const address = body.address === null ? null : String(body.address).trim()
      if (address && address.length > 240) throw new ApiError(422, 'validation_failed', 'Address must be 240 characters or fewer.')
      updates.push(`address = $${index++}`); values.push(address || null)
    }
    if (body.country !== undefined) {
      const country = body.country === null ? null : String(body.country).trim().toUpperCase()
      if (country && !/^[A-Z]{2}$/.test(country)) throw new ApiError(422, 'validation_failed', 'Country must be a two-letter ISO code.')
      updates.push(`country = $${index++}`); values.push(country || null)
    }
    if (!updates.length) throw new ApiError(422, 'validation_failed', 'No fields to update were provided.')

    values.push(storeId)
    const result = await db.query(
      `update public.stores set ${updates.join(', ')}, updated_at = now() where id = $${index}
       returning id, name, timezone, currency, address, country`,
      values,
    )
    if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Store not found.')
    res.json(result.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

export const storesRouter = Router()
storesRouter.get('/:id', (req, res) => void getStore(req, res))
storesRouter.patch('/:id', (req, res) => void patchStore(req, res))
