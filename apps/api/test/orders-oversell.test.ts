import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

const root = fileURLToPath(new URL('../../../', import.meta.url))

// A sale must never be allowed to push stock negative: the decrement query now only applies when
// enough stock exists, and an insufficient-stock line rejects (and rolls back) the whole order —
// no partial decrement across the order's other line items, no stock change at all.
test('a sale that would oversell a product is rejected and rolls back the whole order', async () => {
  process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
  const { db } = await import('../src/db.js')
  const { createApp } = await import('../src/app.js')
  const database = new PGlite()
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
    for (const name of ['202609130001_auth_and_stores.sql', '202609150001_catalog_checkout_sync.sql',
      '202609150001_terminal_employee_access.sql', '202609150002_terminal_device_sessions.sql',
      '202609150003_team_profile_visibility.sql', '202609160001_customers_and_sale_attachment.sql',
      '202609170001_change_feed_product_entity.sql', '202609170002_cart_discounts.sql',
      '202609180001_terminal_name_uniqueness.sql', '202609180002_pos_orders_report_read_access.sql', '202609220002_product_variants.sql']) {
      await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
    }
    const owner = randomUUID(), store = randomUUID(), device = randomUUID()
    const productShort = randomUUID(), productPlenty = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by) values ($1,'One','oversell',$2)", [store, owner])
    const { createHash } = await import('node:crypto')
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    const deviceAccess = 'a'.repeat(64)
    await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
      values ($1,$2,'Counter','OVR-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
      [device, store, owner, digest('c'.repeat(64)), digest(deviceAccess)])
    await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
      values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(deviceAccess), digest('d'.repeat(64))])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-SHORT','Short stock item',100)`, [productShort, store])
    await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,3)', [store, productShort])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-PLENTY','Plenty of stock item',100)`, [productPlenty, store])
    await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,50)', [store, productPlenty])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; release: () => void }> }
    const query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.query = query
    fixture.connect = async () => ({ query, release: () => undefined })
    server = createApp({ pool: db, origin: 'http://127.0.0.1:3186', supabaseUrl: 'http://127.0.0.1:3187', supabaseKey: 'fixture', secureCookies: false }).listen(3186, '127.0.0.1')

    const buildBody = (productId: string, sku: string, name: string, quantity: number, operationId: string, receipt: string) => ({
      operation_id: operationId,
      order: { id: operationId, store_id: store, receipt_number: receipt, catalog_version: 1,
        client_generated_at: new Date().toISOString(), subtotal_cents: 100 * quantity, discount_cents: 0, tax_cents: 0, total_cents: 100 * quantity,
        customer_id: null, employee_id: null, manager_id: null, manager_approved_at: null },
      items: [{ id: randomUUID(), product_id: productId, snapshot_name: name, snapshot_sku: sku,
        snapshot_price_cents: 100, snapshot_tax_bps: 0, catalog_version: 1, quantity,
        discount_kind: null, discount_value: null, subtotal_cents: 100 * quantity, discount_applied_cents: 0, taxable_cents: 100 * quantity, tax_cents: 0, total_cents: 100 * quantity }],
      payment: { id: randomUUID(), method: 'cash', amount_cents: 100 * quantity, tendered_cents: 100 * quantity, change_cents: 0, reference: null },
    })
    const buildMultiBody = (operationId: string, receipt: string) => ({
      operation_id: operationId,
      order: { id: operationId, store_id: store, receipt_number: receipt, catalog_version: 1,
        client_generated_at: new Date().toISOString(), subtotal_cents: 700, discount_cents: 0, tax_cents: 0, total_cents: 700,
        customer_id: null, employee_id: null, manager_id: null, manager_approved_at: null },
      items: [
        { id: randomUUID(), product_id: productPlenty, snapshot_name: 'Plenty of stock item', snapshot_sku: 'SKU-PLENTY',
          snapshot_price_cents: 100, snapshot_tax_bps: 0, catalog_version: 1, quantity: 2,
          discount_kind: null, discount_value: null, subtotal_cents: 200, discount_applied_cents: 0, taxable_cents: 200, tax_cents: 0, total_cents: 200 },
        { id: randomUUID(), product_id: productShort, snapshot_name: 'Short stock item', snapshot_sku: 'SKU-SHORT',
          snapshot_price_cents: 100, snapshot_tax_bps: 0, catalog_version: 1, quantity: 5,
          discount_kind: null, discount_value: null, subtotal_cents: 500, discount_applied_cents: 0, taxable_cents: 500, tax_cents: 0, total_cents: 500 },
      ],
      payment: { id: randomUUID(), method: 'cash', amount_cents: 700, tendered_cents: 700, change_cents: 0, reference: null },
    })
    const push = (body: unknown) => fetch('http://127.0.0.1:3186/pos/orders/push',
      { method: 'POST', headers: { Origin: 'http://127.0.0.1:3186', Cookie: `terminal_access=${deviceAccess}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

    // 1. Selling more than what's on hand (3 in stock, ring up 10) is rejected; stock is untouched.
    const overResp = await push(buildBody(productShort, 'SKU-SHORT', 'Short stock item', 10, randomUUID(), 'OVR-000001'))
    assert.equal(overResp.status, 409)
    const overBody = await overResp.json() as { code: string }
    assert.equal(overBody.code, 'insufficient_stock')
    const stockAfterOver = await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productShort])
    assert.equal(stockAfterOver.rows[0].current_stock, 3)
    const ordersAfterOver = await database.query('select id from public.pos_orders where store_id=$1', [store])
    assert.equal(ordersAfterOver.rows.length, 0)

    // 2. Selling exactly what's on hand succeeds and lands stock at 0.
    const exactResp = await push(buildBody(productShort, 'SKU-SHORT', 'Short stock item', 3, randomUUID(), 'OVR-000002'))
    assert.equal(exactResp.status, 200)
    const stockAfterExact = await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productShort])
    assert.equal(stockAfterExact.rows[0].current_stock, 0)

    // 3. Restock, then a multi-line order where only the second line is short must roll back
    // entirely — the first line's stock (which had plenty) must be left untouched too.
    await database.query('update public.pos_stock set current_stock=2 where store_id=$1 and product_id=$2', [store, productShort])
    const plentyBefore = await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productPlenty])
    assert.equal(plentyBefore.rows[0].current_stock, 50)

    const multiResp = await push(buildMultiBody(randomUUID(), 'OVR-000003'))
    assert.equal(multiResp.status, 409)
    const multiBody = await multiResp.json() as { code: string }
    assert.equal(multiBody.code, 'insufficient_stock')
    const plentyAfter = await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productPlenty])
    assert.equal(plentyAfter.rows[0].current_stock, 50, 'the first line item must not be decremented when a later line in the same order fails')
    const shortAfter = await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productShort])
    assert.equal(shortAfter.rows[0].current_stock, 2)
    const ordersAfterMulti = await database.query('select id from public.pos_orders where store_id=$1', [store])
    assert.equal(ordersAfterMulti.rows.length, 1, 'still only the one order accepted in step 2')
  } finally { server?.closeAllConnections(); server?.close(); await database.close(); await db.end() }
})
