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

// Free, keyless FX source (open.er-api.com) covering the full CURRENCY_OPTIONS list used by
// Signup/StoreDetails, including currencies outside the ECB reference set. Rates are inherently
// approximate real numbers — that's unavoidable for a currency conversion, unlike same-currency
// money math — but the value actually persisted is always produced by Postgres's numeric round(),
// never JS floating-point arithmetic, so the stored cents are exact integers.
async function fetchExchangeRate(from: string, to: string): Promise<number> {
  let response: Response
  try {
    response = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`, { signal: AbortSignal.timeout(8_000) })
  } catch {
    throw new ApiError(503, 'exchange_rate_unavailable', `Could not reach the exchange rate service to convert ${from} to ${to}. Try again.`)
  }
  if (!response.ok) throw new ApiError(503, 'exchange_rate_unavailable', `Exchange rate service returned an error (${response.status}).`)
  const data = (await response.json().catch(() => null)) as { result?: string; rates?: Record<string, number> } | null
  if (!data || data.result !== 'success' || !data.rates) throw new ApiError(503, 'exchange_rate_unavailable', 'Exchange rate service returned no usable data.')
  const rate = data.rates[to]
  if (!Number.isFinite(rate) || rate <= 0) throw new ApiError(422, 'validation_failed', `No exchange rate is available from ${from} to ${to}.`)
  return rate
}

// ---------------------------------------------------------------------------
// PATCH /stores/:id — owner/manager edits business details.
// Partial update: only fields present in the body are changed. name is deliberately
// not editable here — it is set at store creation and not part of this task's scope.
//
// Changing currency converts every product's price using a live exchange rate, rather than
// just relabeling the same integer cents as a different currency (which would silently turn a
// $1.00 item into a 1.00 PKR item — off by roughly 278x). Tax rates are percentages (basis
// points), not money amounts, so they never need conversion. Historical orders/payments keep
// their own currency snapshot from checkout time and are never touched here.
// ---------------------------------------------------------------------------
async function patchStore(req: import('express').Request, res: import('express').Response) {
  try {
    const storeId = String(req.params.id ?? '')
    if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store ID is required.')
    await requireStoreManager(req, storeId)
    const body = req.body as Record<string, unknown>

    const currentRes = await db.query<{ currency: string }>('select currency from public.stores where id=$1', [storeId])
    if (!currentRes.rows[0]) throw new ApiError(404, 'not_found', 'Store not found.')
    const currentCurrency = currentRes.rows[0].currency

    const updates: string[] = []
    const values: unknown[] = []
    let index = 1
    let newCurrency: string | null = null

    if (body.currency !== undefined) {
      const currency = String(body.currency).trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError(422, 'validation_failed', 'Currency must be a three-letter ISO code.')
      newCurrency = currency
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

    const changingCurrency = newCurrency !== null && newCurrency !== currentCurrency
    // Fetch the rate before opening a transaction — an external HTTP call has no business
    // holding a database transaction open while it's in flight.
    const rate = changingCurrency ? await fetchExchangeRate(currentCurrency, newCurrency as string) : null

    const client = await db.connect()
    try {
      await client.query('begin')
      values.push(storeId)
      const result = await client.query(
        `update public.stores set ${updates.join(', ')}, updated_at = now() where id = $${index}
         returning id, name, timezone, currency, address, country`,
        values,
      )
      if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Store not found.')

      let repriced: { product_count: number; rate: number; from: string; to: string } | null = null
      let updatedProducts: { id: string; unit_price_cents: string }[] = []
      if (changingCurrency && rate !== null) {
        const priceRes = await client.query<{ id: string; unit_price_cents: string }>(
          `update public.pos_products set unit_price_cents = round(unit_price_cents * $1::numeric)::bigint
           where store_id = $2
           returning id, unit_price_cents::text as unit_price_cents`,
          [rate, storeId],
        )
        updatedProducts = priceRes.rows
        repriced = { product_count: updatedProducts.length, rate, from: currentCurrency, to: newCurrency as string }
      }

      await client.query('commit')
      res.json({ ...result.rows[0], repriced, updated_products: updatedProducts })
    } catch (reason) {
      await client.query('rollback')
      throw reason
    } finally {
      client.release()
    }
  } catch (reason) { sendApiError(res, reason) }
}

export const storesRouter = Router()
storesRouter.get('/:id', (req, res) => void getStore(req, res))
storesRouter.patch('/:id', (req, res) => void patchStore(req, res))
