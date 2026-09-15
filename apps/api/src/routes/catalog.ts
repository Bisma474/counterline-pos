import { Router } from 'express'
import { db } from '../db.js'
import { requireStoreMember, sendApiError, ApiError } from './auth.js'

export const catalogRouter = Router()
catalogRouter.get('/snapshot', async (req, res) => {
  try {
    const storeId = String(req.query.store_id ?? '')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store ID is required.')
    await requireStoreMember(req, storeId)
    const client = await db.connect()
    try {
      await client.query('begin')
      const feed = await client.query('select last_position::text from public.pos_sync_feed_state where store_id=$1 for update', [storeId])
      if (!feed.rows[0]) throw new ApiError(503, 'server_unavailable', 'Store snapshot is not initialized.')
      const store = await client.query('select id,name,timezone,currency from public.stores where id = $1', [storeId])
      const categories = await client.query('select id,store_id,name,active from public.pos_categories where store_id = $1 order by name', [storeId])
      const taxRates = await client.query('select id,store_id,name,rate_bps,active from public.pos_tax_rates where store_id = $1', [storeId])
      const products = await client.query('select id,store_id,sku,barcode,name,category_id,tax_rate_id,unit_price_cents::text,active,revision::text from public.pos_products where store_id = $1 order by name', [storeId])
      const stock = await client.query('select product_id,current_stock,updated_at from public.pos_stock where store_id = $1', [storeId])
      await client.query('commit')
      res.json({ store: store.rows[0], catalog_version: 1, checkpoint: feed.rows[0].last_position,
        categories: categories.rows, tax_rates: taxRates.rows, products: products.rows, stock: stock.rows })
    } catch (reason) { await client.query('rollback'); throw reason }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
})
