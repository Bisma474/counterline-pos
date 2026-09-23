import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'

// Exchange — API-level correctness tests. Same fixture technique as refund-partial.test.ts: a real
// createApp() HTTP surface against an in-memory Postgres (PGlite) with every migration applied,
// plus a fake "Supabase identity" HTTP server so requireStoreManager()'s auth.getUser(token) call
// resolves fixture users.

const root = fileURLToPath(new URL('../../../', import.meta.url))
const MIGRATIONS = [
  '202609130001_auth_and_stores.sql',
  '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql',
  '202609150002_terminal_device_sessions.sql',
  '202609150003_team_profile_visibility.sql',
  '202609160001_customers_and_sale_attachment.sql',
  '202609170001_change_feed_product_entity.sql',
  '202609170002_cart_discounts.sql',
  '202609180001_terminal_name_uniqueness.sql',
  '202609180002_pos_orders_report_read_access.sql',
  '202609180002_store_business_details.sql',
  '202609180003_tax_rate_change_feed.sql',
  '202609180004_product_images.sql',
  '202609180005_refunds.sql',
  '202609190001_audit_log.sql',
  '202609190001_store_onboarding_status.sql',
  '202609190002_remove_demo_catalog_seed.sql',
  '202609190003_store_sync_feed_init.sql',
  '202609200001_service_role_only_rls_policies.sql',
  '202609220001_inventory_operations.sql',
  '202609220002_product_variants.sql',
  '202609230001_partial_refunds.sql', '202609240001_terminal_manager_refund_approval.sql',
]

test('Exchange: RBAC, net-owed and net-refund directions, atomicity, the exchange_order_id link, and idempotent replay', async () => {
  process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
  process.env.SUPABASE_URL = 'http://127.0.0.1:3790'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture'
  const { db } = await import('../src/db.js')
  const { createApp } = await import('../src/app.js')

  const database = new PGlite()
  let identityServer: ReturnType<express.Express['listen']> | undefined
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';
      create schema storage;
      create table storage.buckets(id text primary key, name text, public boolean);
      create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
      create function storage.foldername(name text) returns text[] language sql as
        $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;`)
    for (const name of MIGRATIONS) {
      const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
      await database.exec(sql)
    }

    const owner = randomUUID(), cashier = randomUUID(), store = randomUUID()
    const cheapProduct = randomUUID(), pricierProduct = randomUUID(), overstockedProduct = randomUUID()
    await database.query('insert into auth.users(id) values ($1),($2)', [owner, cashier])
    await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture Store','exchange',$2)", [store, owner])
    await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'owner'),($1,$3,'cashier')", [store, owner, cashier])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values
      ($1,$4,'SKU-CHEAP','Cheap item',1000), ($2,$4,'SKU-PRICIER','Pricier item',1800), ($3,$4,'SKU-LOW','Nearly out item',500)`,
      [cheapProduct, pricierProduct, overstockedProduct, store])
    await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,10),($1,$3,10),($1,$4,1)', [store, cheapProduct, pricierProduct, overstockedProduct])

    const tokenFor = (userId: string) => `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture-${userId}`
    const ownerToken = tokenFor(owner), cashierToken = tokenFor(cashier)
    const usersByToken = new Map([
      [ownerToken, { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@fixture.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }],
      [cashierToken, { id: cashier, aud: 'authenticated', role: 'authenticated', email: 'cashier@fixture.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }],
    ])
    const identity = express()
    identity.get('/auth/v1/user', (req, res) => {
      const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1]
      const user = token ? usersByToken.get(token) : undefined
      if (!user) { res.sendStatus(401); return }
      res.json(user)
    })
    identityServer = identity.listen(3790, '127.0.0.1')

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; release: () => void }> }
    let tail = Promise.resolve()
    const query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.query = query
    fixture.connect = async () => {
      const previous = tail; let release!: () => void
      tail = new Promise<void>(resolve => { release = resolve }); await previous
      return { query, release }
    }

    server = createApp({ pool: db, origin: 'http://127.0.0.1:3789', supabaseUrl: 'http://127.0.0.1:3790', supabaseKey: 'fixture', secureCookies: false }).listen(3789, '127.0.0.1')
    const base = 'http://127.0.0.1:3789'
    const call = (path: string, token: string | null, init: { method?: string; body?: unknown } = {}) =>
      fetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      })
    const stockOf = async (productId: string) => (await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productId])).rows[0].current_stock

    // Seed a 1-item order for the "returned" side: 1 unit of the cheap product, 1000 subtotal, no tax.
    const seedOrder = async (receipt: string, productId: string, priceCents: number) => {
      const orderId = randomUUID(), itemId = randomUUID()
      await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at)
        values ($1,$2,$3,'USD','Fixture Store','UTC',$4,0,0,$4,1,now())`, [orderId, store, receipt, priceCents])
      await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
        snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
        values ($1,$2,$3,$4,'Item','SKU',$5,0,1,1,$5,0,$5,0,$5)`, [itemId, store, orderId, productId, priceCents])
      await database.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,client_generated_at)
        values ($1,$2,$3,'card',$4,$4,0,now())`, [randomUUID(), store, orderId, priceCents])
      return { orderId, itemId }
    }

    const buildNewOrder = (productId: string, priceCents: number, quantity: number, receipt: string) => {
      const opId = randomUUID(), itemId = randomUUID(), total = priceCents * quantity
      return {
        operation_id: opId,
        order: { id: opId, store_id: store, receipt_number: receipt, catalog_version: 1, client_generated_at: new Date().toISOString(),
          subtotal_cents: total, discount_cents: 0, tax_cents: 0, total_cents: total, customer_id: null, employee_id: null, manager_id: null, manager_approved_at: null },
        items: [{ id: itemId, product_id: productId, snapshot_name: 'New item', snapshot_sku: 'SKU-NEW', snapshot_price_cents: priceCents,
          snapshot_tax_bps: 0, catalog_version: 1, quantity, discount_kind: null, discount_value: null,
          subtotal_cents: total, discount_applied_cents: 0, taxable_cents: total, tax_cents: 0, total_cents: total }],
        payment: { id: randomUUID(), method: 'card', amount_cents: total, tendered_cents: total, change_cents: 0, reference: null },
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 1. RBAC — a cashier cannot exchange, at all.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const { orderId, itemId } = await seedOrder('EX-000001', cheapProduct, 1000)
      const resp = await call(`/orders/${orderId}/exchange`, cashierToken, {
        method: 'POST', body: { store_id: store, operation_id: randomUUID(), return_items: [{ order_item_id: itemId, quantity: 1 }], new_order: buildNewOrder(pricierProduct, 1800, 1, 'EX-N-000001') },
      })
      assert.equal(resp.status, 403)
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 2. Net-owed direction: return a 1000-cent item, take a 1800-cent replacement — customer
    // owes 800 more. Both halves must commit: refund restocked, new order decremented, linked.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const { orderId, itemId } = await seedOrder('EX-000002', cheapProduct, 1000)
      const cheapStockBefore = await stockOf(cheapProduct)
      const pricierStockBefore = await stockOf(pricierProduct)
      const newOrder = buildNewOrder(pricierProduct, 1800, 1, 'EX-N-000002')
      const resp = await call(`/orders/${orderId}/exchange`, ownerToken, {
        method: 'POST', body: { store_id: store, operation_id: randomUUID(), return_items: [{ order_item_id: itemId, quantity: 1 }], new_order: newOrder },
      })
      assert.equal(resp.status, 201)
      const body = await resp.json() as { refund: { id: string; amount_cents: string; exchange_order_id: string }; new_order: { operation_id: string }; net_amount_cents: number }
      assert.equal(Number(body.refund.amount_cents), 1000)
      assert.equal(body.refund.exchange_order_id, newOrder.operation_id)
      assert.equal(body.net_amount_cents, 1800 - 1000, 'customer owes 800 more')
      assert.equal(await stockOf(cheapProduct), cheapStockBefore + 1, 'returned item restocked')
      assert.equal(await stockOf(pricierProduct), pricierStockBefore - 1, 'replacement item decremented')
      const newOrderRow = await database.query('select 1 from public.pos_orders where store_id=$1 and id=$2', [store, newOrder.operation_id])
      assert.equal(newOrderRow.rowCount, 1, 'the replacement order was actually created')
      const auditRow = await database.query("select 1 from public.audit_log where store_id=$1 and action='order.exchange'", [store])
      assert.equal(auditRow.rowCount, 1)
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 3. Net-refund direction: return an 1800-cent item, take a 1000-cent replacement — customer
    // gets 800 back (negative net_amount_cents).
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const { orderId, itemId } = await seedOrder('EX-000003', pricierProduct, 1800)
      const newOrder = buildNewOrder(cheapProduct, 1000, 1, 'EX-N-000003')
      const resp = await call(`/orders/${orderId}/exchange`, ownerToken, {
        method: 'POST', body: { store_id: store, operation_id: randomUUID(), return_items: [{ order_item_id: itemId, quantity: 1 }], new_order: newOrder },
      })
      assert.equal(resp.status, 201)
      const body = await resp.json() as { net_amount_cents: number }
      assert.equal(body.net_amount_cents, 1000 - 1800, 'customer gets 800 back')
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 4. Atomicity: the replacement item is oversold (only 1 in stock, order asks for 5) — the
    // whole exchange must roll back. No refund row, no stock change on either side, no new order.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const { orderId, itemId } = await seedOrder('EX-000004', cheapProduct, 1000)
      const cheapStockBefore = await stockOf(cheapProduct)
      const lowStockBefore = await stockOf(overstockedProduct)
      const newOrder = buildNewOrder(overstockedProduct, 500, 5, 'EX-N-000004')
      const resp = await call(`/orders/${orderId}/exchange`, ownerToken, {
        method: 'POST', body: { store_id: store, operation_id: randomUUID(), return_items: [{ order_item_id: itemId, quantity: 1 }], new_order: newOrder },
      })
      assert.equal(resp.status, 409)
      assert.equal((await resp.json() as { code: string }).code, 'insufficient_stock')
      assert.equal(await stockOf(cheapProduct), cheapStockBefore, 'the return side must not have applied either — all or nothing')
      assert.equal(await stockOf(overstockedProduct), lowStockBefore)
      const refundRow = await database.query('select 1 from public.pos_refunds where store_id=$1 and order_id=$2', [store, orderId])
      assert.equal(refundRow.rowCount, 0, 'no orphan refund row from the half that would have succeeded')
      const newOrderRow = await database.query('select 1 from public.pos_orders where store_id=$1 and id=$2', [store, newOrder.operation_id])
      assert.equal(newOrderRow.rowCount, 0, 'no orphan order row')
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 5. Idempotent replay: same operation_id + identical body is a true no-op; a reused
    // operation_id with a different body is rejected as a conflict.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const { orderId, itemId } = await seedOrder('EX-000005', cheapProduct, 1000)
      const newOrder = buildNewOrder(pricierProduct, 1800, 1, 'EX-N-000005')
      const opId = randomUUID()
      const requestBody = { store_id: store, operation_id: opId, return_items: [{ order_item_id: itemId, quantity: 1 }], new_order: newOrder }

      const first = await call(`/orders/${orderId}/exchange`, ownerToken, { method: 'POST', body: requestBody })
      assert.equal(first.status, 201)
      const firstJson = await first.json()

      const replay = await call(`/orders/${orderId}/exchange`, ownerToken, { method: 'POST', body: requestBody })
      assert.equal(replay.status, 201)
      assert.deepEqual(await replay.json(), firstJson)
      const refundCount = await database.query('select 1 from public.pos_refunds where store_id=$1 and order_id=$2', [store, orderId])
      assert.equal(refundCount.rowCount, 1, 'the replay must not have created a second refund')

      const conflicting = await call(`/orders/${orderId}/exchange`, ownerToken, { method: 'POST', body: { ...requestBody, reason: 'different payload, same operation_id' } })
      assert.equal(conflicting.status, 409)
      assert.equal((await conflicting.json() as { code: string }).code, 'operation_id_conflict')
    }

    console.log('PASS: exchange composes refund + new-order creation atomically, in both net-owed and net-refund directions, rolls back fully on failure, links via exchange_order_id, and is idempotent.')
  } finally {
    server?.closeAllConnections(); server?.close(); identityServer?.close(); await database.close(); await db.end()
  }
})
