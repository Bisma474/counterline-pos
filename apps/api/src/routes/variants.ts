import { Router, type Request, type Response } from 'express'
import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { ApiError, requireStoreManager, sendApiError } from './auth.js'
import { variantName, variantOptions } from '../../../../packages/domain/src/variants.js'

export const variantsRouter = Router()
const uuid = (value: unknown) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ApiError(422, 'validation_failed', 'A valid store or product ID is required.')
  return value
}
function text(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new ApiError(422, 'validation_failed', `${label} is required, up to ${max} characters.`)
  return value.trim()
}
function integer(value: unknown, label: string, max: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new ApiError(422, 'validation_failed', `${label} must be an integer from 0 to ${max}.`)
  return value
}
function revision(body: Record<string, unknown>, actual: unknown) {
  if (String(body.revision) !== String(actual)) throw new ApiError(409, 'revision_conflict', 'This record changed. Reload variants before saving again.')
}
async function feed(client: PoolClient, store: string, entity: string, id: string, payload: unknown, action = 'upsert') {
  const next = await client.query('update public.pos_sync_feed_state set last_position=last_position+1 where store_id=$1 returning last_position::text', [store])
  await client.query('insert into public.pos_change_feed(store_id,position,entity_type,entity_id,action,payload) values($1,$2,$3,$4,$5,$6)', [store, next.rows[0].last_position, entity, id, action, JSON.stringify(payload)])
}
async function publishProduct(client: PoolClient, store: string, id: string) {
  const product = await client.query(`select p.*, parent.name as parent_name from public.pos_products p
    join public.pos_product_parents parent on parent.id=p.parent_product_id where p.store_id=$1 and p.id=$2`, [store, id])
  const stock = await client.query('select product_id,current_stock,updated_at from public.pos_stock where store_id=$1 and product_id=$2', [store,id])
  const row = product.rows[0]
  await feed(client,store,'product',id,{ product: { ...row, unit_price_cents: Number(row.unit_price_cents), revision: Number(row.revision) }, stock: stock.rows[0] })
}
async function transaction(req: Request, res: Response, work: (client: PoolClient, store: string, body: Record<string, unknown>) => Promise<unknown>, status = 200) {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const store = uuid(req.method === 'GET' ? req.query.store_id : body.store_id)
    await requireStoreManager(req, store)
    const client = await db.connect()
    try {
      await client.query('begin')
      const lock = await client.query('select last_position from public.pos_sync_feed_state where store_id=$1 for update', [store])
      if (!lock.rowCount) throw new ApiError(503, 'server_unavailable', 'Store catalog is not initialized.')
      const result = await work(client, store, body)
      await client.query('commit')
      res.status(status).json(result)
    } catch (error) { await client.query('rollback'); throw error }
    finally { client.release() }
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
      sendApiError(res, new ApiError(409, 'variant_conflict', 'This SKU or option combination already exists.'))
    } else sendApiError(res,error)
  }
}

variantsRouter.get('/product-parents', (req,res) => void transaction(req,res,async (client,store) => {
  const parents = await client.query('select id,store_id,name,revision::text from public.pos_product_parents where store_id=$1 order by name', [store])
  const variants = await client.query(`select p.*,s.current_stock from public.pos_products p join public.pos_stock s on s.store_id=p.store_id and s.product_id=p.id
    where p.store_id=$1 and p.parent_product_id is not null order by p.name`, [store])
  return { parents: parents.rows, variants: variants.rows.map(row => ({ ...row, unit_price_cents: Number(row.unit_price_cents), revision: String(row.revision) })) }
}))
variantsRouter.post('/product-parents', (req,res) => void transaction(req,res,async (client,store,body) => {
  const name = text(body.name,'Parent product name',80)
  const parent = (await client.query('insert into public.pos_product_parents(store_id,name) values($1,$2) returning *', [store,name])).rows[0]
  await feed(client,store,'product_parent',parent.id,parent)
  return { parent }
},201))
variantsRouter.patch('/product-parents/:id', (req,res) => void transaction(req,res,async (client,store,body) => {
  const id = uuid(req.params.id), name = text(body.name,'Parent product name',80)
  const parent = (await client.query('select * from public.pos_product_parents where store_id=$1 and id=$2', [store,id])).rows[0]
  if (!parent) throw new ApiError(404,'not_found','Parent product not found.')
  revision(body,parent.revision)
  const children = await client.query('select id,option_values from public.pos_products where store_id=$1 and parent_product_id=$2', [store,id])
  for (const child of children.rows) {
    let display: string
    try { display = variantName(name,variantOptions(child.option_values)) }
    catch (error) { throw new ApiError(422,'validation_failed',(error as Error).message) }
    await client.query('update public.pos_products set name=$3,revision=revision+1 where store_id=$1 and id=$2', [store,child.id,display])
  }
  const updated = (await client.query('update public.pos_product_parents set name=$3,revision=revision+1 where store_id=$1 and id=$2 returning *', [store,id,name])).rows[0]
  await feed(client,store,'product_parent',id,updated)
  for (const child of children.rows) await publishProduct(client,store,child.id)
  return { parent: updated }
}))

async function saveVariant(req: Request, res: Response, create: boolean) {
  return transaction(req,res,async (client,store,body) => {
    const parentId = uuid(body.parent_product_id)
    const parent = (await client.query('select name from public.pos_product_parents where store_id=$1 and id=$2',[store,parentId])).rows[0]
    if (!parent) throw new ApiError(404,'not_found','Parent product not found in this store.')
    let options: ReturnType<typeof variantOptions>, name: string
    try { options = variantOptions(body.option_values); name = variantName(parent.name,options) }
    catch (error) { throw new ApiError(422,'validation_failed',(error as Error).message) }
    const sku = text(body.sku,'SKU',80)
    const barcode = body.barcode === null || body.barcode === '' || body.barcode === undefined ? null : text(body.barcode,'Barcode',80)
    if (barcode && !/^[A-Za-z0-9]+$/.test(barcode)) throw new ApiError(422,'validation_failed','Barcode must be alphanumeric.')
    const price = integer(body.unit_price_cents,'Price in cents',1_000_000_000)
    if (typeof body.active !== 'boolean') throw new ApiError(422,'validation_failed','Active must be true or false.')
    const category = body.category_id ? uuid(body.category_id) : null
    const tax = body.tax_rate_id ? uuid(body.tax_rate_id) : null
    for (const [table,id] of [['pos_categories',category],['pos_tax_rates',tax]]) {
      if (id && !(await client.query(`select 1 from public.${table} where store_id=$1 and id=$2 and active=true`,[store,id])).rowCount) throw new ApiError(422,'validation_failed','Category or tax rate is unavailable in this store.')
    }
    const id = create ? crypto.randomUUID() : uuid(req.params.id)
    const previous = create ? null : (await client.query('select * from public.pos_products where store_id=$1 and id=$2 and parent_product_id=$3',[store,id,parentId])).rows[0]
    if (!create && !previous) throw new ApiError(404,'not_found','Variant not found.')
    if (previous) revision(body,previous.revision)
    // Store lock serializes SKU/barcode checks with catalog writes. Refuse any ambiguity
    // with existing product barcodes or SKUs; legacy duplicate scans still use the picker.
    const conflict = await client.query(`select 1 from public.pos_products where store_id=$1 and id<>$2 and
      (lower(sku)=lower($3) or ($4::text is not null and (lower(barcode)=lower($4) or lower(sku)=lower($4))) or lower(barcode)=lower($3))`,[store,id,sku,barcode])
    if (conflict.rowCount) throw new ApiError(409,'variant_conflict','SKU or barcode conflicts with another product in this store.')
    const draft = create ? true : previous.is_draft && !body.active
    if (create && body.active) throw new ApiError(422,'validation_failed','Create a draft first, then activate it for sale.')
    if (create) {
      const stock = integer(body.initial_stock ?? 0,'Initial stock',1_000_000)
      await client.query(`insert into public.pos_products(id,store_id,parent_product_id,option_values,is_draft,name,sku,barcode,unit_price_cents,active,category_id,tax_rate_id)
        values($1,$2,$3,$4,true,$5,$6,$7,$8,false,$9,$10)`,[id,store,parentId,JSON.stringify(options),name,sku,barcode,price,category,tax])
      await client.query('insert into public.pos_stock(store_id,product_id,current_stock) values($1,$2,$3)',[store,id,stock])
      if (stock) await client.query("insert into public.pos_inventory_movements(store_id,product_id,operation_id,delta,reason) values($1,$2,gen_random_uuid(),$3,'opening_stock')",[store,id,stock])
    } else {
      if (body.initial_stock !== undefined) throw new ApiError(422,'validation_failed','Stock editing is outside variant setup. Initial stock is set at creation only.')
      await client.query(`update public.pos_products set option_values=$3,name=$4,sku=$5,barcode=$6,unit_price_cents=$7,active=$8,is_draft=$9,category_id=$10,tax_rate_id=$11,revision=revision+1
        where store_id=$1 and id=$2`,[store,id,JSON.stringify(options),name,sku,barcode,price,body.active,draft,category,tax])
    }
    await publishProduct(client,store,id)
    return { id }
  }, create ? 201 : 200)
}
variantsRouter.post('/variants',(req,res) => void saveVariant(req,res,true))
variantsRouter.patch('/variants/:id',(req,res) => void saveVariant(req,res,false))
variantsRouter.delete('/variants/:id',(req,res) => void transaction(req,res,async(client,store,body) => {
  const id = uuid(req.params.id)
  const row = (await client.query('select is_draft,revision from public.pos_products where store_id=$1 and id=$2 and parent_product_id is not null',[store,id])).rows[0]
  if (!row) throw new ApiError(404,'not_found','Variant not found.')
  revision(body,row.revision)
  if (!row.is_draft || (await client.query('select 1 from public.pos_order_items where store_id=$1 and product_id=$2',[store,id])).rowCount) throw new ApiError(409,'variant_published','Published or sold variants can only be deactivated. Offline sales may still exist.')
  await client.query("delete from public.pos_inventory_movements where store_id=$1 and product_id=$2 and reason='opening_stock'",[store,id])
  await client.query('delete from public.pos_stock where store_id=$1 and product_id=$2',[store,id])
  await client.query('delete from public.pos_products where store_id=$1 and id=$2',[store,id])
  await feed(client,store,'product',id,{ id },'delete')
  return { id, removed: true }
}))
