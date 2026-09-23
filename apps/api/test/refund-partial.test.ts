import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'

// Partial (line-item, repeatable) refund — API-level correctness tests. Same fixture technique as
// inventory-api.test.ts: a real createApp() HTTP surface against an in-memory Postgres (PGlite)
// with every migration applied, plus a tiny fake "Supabase identity" HTTP server so
// requireStoreManager()'s real auth.getUser(token) call resolves fixture users.

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

test('Partial refund: quantity limits, repeat refunds, idempotency, RBAC, concurrency, and the DB-trigger backstop', async () => {
  process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
  process.env.SUPABASE_URL = 'http://127.0.0.1:3690'
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
    const productA = randomUUID(), productB = randomUUID()
    await database.query('insert into auth.users(id) values ($1),($2)', [owner, cashier])
    await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture Store','refund-partial',$2)", [store, owner])
    await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'owner'),($1,$3,'cashier')", [store, owner, cashier])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-A','Product A',500),($3,$2,'SKU-B','Product B',1000)`, [productA, store, productB])
    await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,10),($1,$3,10)', [store, productA, productB])

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
    identityServer = identity.listen(3690, '127.0.0.1')

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

    server = createApp({ pool: db, origin: 'http://127.0.0.1:3689', supabaseUrl: 'http://127.0.0.1:3690', supabaseKey: 'fixture', secureCookies: false }).listen(3689, '127.0.0.1')
    const base = 'http://127.0.0.1:3689'
    const call = (path: string, token: string | null, init: { method?: string; body?: unknown } = {}) =>
      fetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      })
    const stockOf = async (productId: string) => (await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productId])).rows[0].current_stock
    const refundedSum = async (orderItemId: string) => {
      const row = (await database.query<{ qty: string; amount: string }>(
        'select coalesce(sum(quantity),0)::text as qty, coalesce(sum(amount_cents),0)::text as amount from public.pos_refund_items where store_id=$1 and order_item_id=$2',
        [store, orderItemId],
      )).rows[0]
      return { quantity: Number(row.qty), amount: Number(row.amount) }
    }

    // Seed a 2-item order directly (order creation itself is covered by orders-oversell.test.ts /
    // orders-duplicate-submit.test.ts; this suite is about the refund endpoint). Item A: 3 units
    // @ 500 = 1500 subtotal, 5% tax = 75, total 1575. Item B: 2 units @ 1000 = 2000, no tax.
    const orderId = randomUUID(), itemA = randomUUID(), itemB = randomUUID()
    await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at)
      values ($1,$2,'RP-000001','USD','Fixture Store','UTC',3500,0,75,3575,1,now())`, [orderId, store])
    await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
      snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
      values ($1,$2,$3,$4,'Product A','SKU-A',500,500,1,3,1500,0,1500,75,1575)`, [itemA, store, orderId, productA])
    await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
      snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
      values ($1,$2,$3,$4,'Product B','SKU-B',1000,0,1,2,2000,0,2000,0,2000)`, [itemB, store, orderId, productB])
    await database.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,client_generated_at)
      values ($1,$2,$3,'card',3575,3575,0,now())`, [randomUUID(), store, orderId])

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 1. RBAC — a cashier cannot refund, at all.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const resp = await call(`/orders/${orderId}/refund`, cashierToken, { method: 'POST', body: { store_id: store, operation_id: randomUUID(), items: [{ order_item_id: itemA, quantity: 1 }] } })
      assert.equal(resp.status, 403)
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 2. Partial refund of less than the full line quantity: exact proportional amount, exact
    // stock restore for just that quantity — the other item and the rest of this item untouched.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const stockABefore = await stockOf(productA)
      const resp = await call(`/orders/${orderId}/refund`, ownerToken, { method: 'POST', body: { store_id: store, operation_id: randomUUID(), items: [{ order_item_id: itemA, quantity: 1 }] } })
      assert.equal(resp.status, 201)
      const body = await resp.json() as { refund: { amount_cents: string }; items: Array<{ order_item_id: string; quantity: number; amount_cents: number }> }
      assert.equal(Number(body.refund.amount_cents), 525) // 1/3 of 1575
      assert.equal(body.items.length, 1)
      assert.equal(body.items[0].quantity, 1)
      assert.equal(await stockOf(productA), stockABefore + 1)
      const sum = await refundedSum(itemA)
      assert.equal(sum.quantity, 1)
      assert.equal(sum.amount, 525)
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 3. A second, later partial refund on a DIFFERENT line of the SAME order must succeed — this
    // is exactly what used to be blocked by pos_refunds' unique(store_id, order_id).
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const resp = await call(`/orders/${orderId}/refund`, ownerToken, { method: 'POST', body: { store_id: store, operation_id: randomUUID(), items: [{ order_item_id: itemB, quantity: 1 }] } })
      assert.equal(resp.status, 201)
      const body = await resp.json() as { refund: { amount_cents: string } }
      assert.equal(Number(body.refund.amount_cents), 1000) // 1/2 of 2000, no tax
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 4. Refunding the remaining 2 units of item A (which sums to exactly its original quantity
    // of 3, across two separate refund calls) must succeed and land on the exact remainder — not
    // a second independently-rounded estimate — so nothing is lost or gained across the two.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const resp = await call(`/orders/${orderId}/refund`, ownerToken, { method: 'POST', body: { store_id: store, operation_id: randomUUID(), items: [{ order_item_id: itemA, quantity: 2 }] } })
      assert.equal(resp.status, 201)
      const body = await resp.json() as { refund: { amount_cents: string } }
      assert.equal(Number(body.refund.amount_cents), 1575 - 525) // exact remainder, not a re-rounded 2/3 share
      const sum = await refundedSum(itemA)
      assert.equal(sum.quantity, 3)
      assert.equal(sum.amount, 1575, 'the two partial refunds of item A sum to exactly its original total, no cent leakage')
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 5. A further attempt to refund even 1 more unit of item A (now fully refunded) must be
    // rejected with a clean 422, not a raw DB trigger error, and must change nothing.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const stockABefore = await stockOf(productA)
      const resp = await call(`/orders/${orderId}/refund`, ownerToken, { method: 'POST', body: { store_id: store, operation_id: randomUUID(), items: [{ order_item_id: itemA, quantity: 1 }] } })
      assert.equal(resp.status, 422)
      const body = await resp.json() as { code: string }
      assert.equal(body.code, 'over_refund')
      assert.equal(await stockOf(productA), stockABefore, 'a rejected over-refund must not touch stock')
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 6. An order_item_id that doesn't belong to this order/store is rejected, not silently
    // accepted or misattributed.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const foreignOrder = randomUUID(), foreignItem = randomUUID()
      await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at)
        values ($1,$2,'RP-000002','USD','Fixture Store','UTC',500,0,0,500,1,now())`, [foreignOrder, store])
      await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
        snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
        values ($1,$2,$3,$4,'Product A','SKU-A',500,0,1,1,500,0,500,0,500)`, [foreignItem, store, foreignOrder, productA])
      const resp = await call(`/orders/${orderId}/refund`, ownerToken, { method: 'POST', body: { store_id: store, operation_id: randomUUID(), items: [{ order_item_id: foreignItem, quantity: 1 }] } })
      assert.equal(resp.status, 422)
      assert.equal((await resp.json() as { code: string }).code, 'item_not_found')
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 7. Idempotent replay: same operation_id + identical body must be a true no-op (no second
    // refund row, same result returned) — necessary now that an order can be refunded more than
    // once, so a retried request must not double-refund. A reused operation_id with a DIFFERENT
    // body must be rejected as a conflict.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      // Fresh order/item so this scenario doesn't collide with the already-exhausted item A.
      const orderId2 = randomUUID(), item2 = randomUUID()
      await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at)
        values ($1,$2,'RP-000003','USD','Fixture Store','UTC',500,0,0,500,1,now())`, [orderId2, store])
      await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
        snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
        values ($1,$2,$3,$4,'Product A','SKU-A',500,0,1,1,500,0,500,0,500)`, [item2, store, orderId2, productA])
      await database.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,client_generated_at)
        values ($1,$2,$3,'cash',500,500,0,now())`, [randomUUID(), store, orderId2])

      const opId = randomUUID()
      const body = { store_id: store, operation_id: opId, items: [{ order_item_id: item2, quantity: 1 }] }
      const first = await call(`/orders/${orderId2}/refund`, ownerToken, { method: 'POST', body })
      assert.equal(first.status, 201)
      const firstJson = await first.json()

      const replay = await call(`/orders/${orderId2}/refund`, ownerToken, { method: 'POST', body })
      assert.equal(replay.status, 201)
      assert.deepEqual(await replay.json(), firstJson)
      const sum = await refundedSum(item2)
      assert.equal(sum.quantity, 1, 'the replay must not have double-refunded')

      const conflicting = await call(`/orders/${orderId2}/refund`, ownerToken, { method: 'POST', body: { ...body, operation_id: opId, reason: 'different payload, same operation_id' } })
      assert.equal(conflicting.status, 409)
      assert.equal((await conflicting.json() as { code: string }).code, 'operation_id_conflict')
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 8. Concurrency: two concurrent requests racing to refund the same line item, together
    // asking for more than remains, must be serialized by the per-store lock so only one
    // succeeds — never both, never a corrupted over-refund.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const orderId3 = randomUUID(), item3 = randomUUID()
      await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at)
        values ($1,$2,'RP-000004','USD','Fixture Store','UTC',500,0,0,500,1,now())`, [orderId3, store])
      await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
        snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
        values ($1,$2,$3,$4,'Product A','SKU-A',500,0,1,1,500,0,500,0,500)`, [item3, store, orderId3, productA])
      await database.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,client_generated_at)
        values ($1,$2,$3,'cash',500,500,0,now())`, [randomUUID(), store, orderId3])

      const [respA, respB] = await Promise.all([
        call(`/orders/${orderId3}/refund`, ownerToken, { method: 'POST', body: { store_id: store, operation_id: randomUUID(), items: [{ order_item_id: item3, quantity: 1 }] } }),
        call(`/orders/${orderId3}/refund`, ownerToken, { method: 'POST', body: { store_id: store, operation_id: randomUUID(), items: [{ order_item_id: item3, quantity: 1 }] } }),
      ])
      const statuses = [respA.status, respB.status].sort()
      assert.deepEqual(statuses, [201, 422], 'exactly one of the two concurrent requests for the only remaining unit must succeed')
      const sum = await refundedSum(item3)
      assert.equal(sum.quantity, 1, 'only 1 unit was ever refunded, despite two concurrent attempts')
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 9. DB-trigger backstop: bypassing the API and inserting pos_refund_items directly must
    // still be rejected once a line's remaining quantity is exhausted — proving the trigger
    // itself works, not just the app-level check.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const orderId4 = randomUUID(), item4 = randomUUID(), refund4 = randomUUID()
      await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at)
        values ($1,$2,'RP-000005','USD','Fixture Store','UTC',500,0,0,500,1,now())`, [orderId4, store])
      await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
        snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
        values ($1,$2,$3,$4,'Product A','SKU-A',500,0,1,1,500,0,500,0,500)`, [item4, store, orderId4, productA])
      await database.query(`insert into public.pos_refunds(id,store_id,order_id,amount_cents,refunded_by) values ($1,$2,$3,500,$4)`, [refund4, store, orderId4, owner])
      await database.query(`insert into public.pos_refund_items(store_id,refund_id,order_item_id,product_id,quantity,amount_cents) values ($1,$2,$3,$4,1,500)`, [store, refund4, item4, productA])
      const refund5 = randomUUID()
      await database.query(`insert into public.pos_refunds(id,store_id,order_id,amount_cents,refunded_by) values ($1,$2,$3,500,$4)`, [refund5, store, orderId4, owner])
      await assert.rejects(
        database.query(`insert into public.pos_refund_items(store_id,refund_id,order_item_id,product_id,quantity,amount_cents) values ($1,$2,$3,$4,1,500)`, [store, refund5, item4, productA]),
        /exceeds remaining/,
      )
    }

    console.log('PASS: partial refunds respect quantity limits, sum without cent leakage, are idempotent, RBAC-gated, concurrency-safe, and backstopped by the DB trigger.')
  } finally {
    server?.closeAllConnections(); server?.close(); identityServer?.close(); await database.close(); await db.end()
  }
})
