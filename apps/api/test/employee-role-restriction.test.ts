import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'

// A manager may create/edit cashier-role terminal employees, but never a manager-role one —
// only an owner can grant or hold manager-level access. Same fixture technique as
// inventory-api.test.ts: PGlite + a fake Supabase identity server so terminalAuthRouter's
// manager() (POST /terminal-auth/employees's real auth check) resolves distinct owner/manager
// fixture users.

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
  '202609230001_partial_refunds.sql',
]

test('A manager may create/edit cashiers, but only an owner may create, promote, demote, or edit a manager-role employee', async () => {
  process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
  process.env.SUPABASE_URL = 'http://127.0.0.1:3593'
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

    const owner = randomUUID(), manager = randomUUID(), store = randomUUID()
    await database.query('insert into auth.users(id) values ($1),($2)', [owner, manager])
    await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture Store','role-fixture',$2)", [store, owner])
    await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'owner'),($1,$3,'manager')", [store, owner, manager])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; release: () => void }> }
    const query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.query = query
    fixture.connect = async () => ({ query, release: () => undefined })

    const tokenFor = (userId: string) => `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture-${userId}`
    const ownerToken = tokenFor(owner), managerToken = tokenFor(manager)
    const usersByToken = new Map([
      [ownerToken, { id: owner }],
      [managerToken, { id: manager }],
    ])
    const identity = express()
    identity.get('/auth/v1/user', (req, res) => {
      const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1]
      const user = token ? usersByToken.get(token) : undefined
      if (!user) { res.sendStatus(401); return }
      res.json(user)
    })
    identityServer = identity.listen(3593, '127.0.0.1')

    server = createApp({ pool: db, origin: 'http://127.0.0.1:3594', supabaseUrl: 'http://127.0.0.1:3593', supabaseKey: 'fixture', secureCookies: false }).listen(3594, '127.0.0.1')
    const call = (token: string, body: Record<string, unknown>) => fetch('http://127.0.0.1:3594/terminal-auth/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3594', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })

    // A manager may create a cashier.
    const cashierResp = await call(managerToken, { store_id: store, name: 'Cashier By Manager', role: 'cashier', active: true, pin: '1234' })
    assert.equal(cashierResp.status, 201)

    // A manager may not create a manager.
    const managerAttempt = await call(managerToken, { store_id: store, name: 'Manager By Manager', role: 'manager', active: true, pin: '5678' })
    assert.equal(managerAttempt.status, 403)
    assert.equal((await managerAttempt.json() as { code: string }).code, 'owner_required')

    // An owner may create a manager.
    const managerByOwner = await call(ownerToken, { store_id: store, name: 'Manager By Owner', role: 'manager', active: true, pin: '9012' })
    assert.equal(managerByOwner.status, 201)
    const managerEmployeeId = (await managerByOwner.json() as { id: string }).id

    // A manager may not edit an existing manager, even to demote them to cashier.
    const demoteAttempt = await call(managerToken, { id: managerEmployeeId, store_id: store, name: 'Manager By Owner', role: 'cashier', active: true })
    assert.equal(demoteAttempt.status, 403)
    assert.equal((await demoteAttempt.json() as { code: string }).code, 'owner_required')

    // A manager may not deactivate an existing manager either (role unchanged, still blocked).
    const deactivateAttempt = await call(managerToken, { id: managerEmployeeId, store_id: store, name: 'Manager By Owner', role: 'manager', active: false })
    assert.equal(deactivateAttempt.status, 403)

    // An owner may edit an existing manager.
    const ownerEdit = await call(ownerToken, { id: managerEmployeeId, store_id: store, name: 'Manager By Owner', role: 'manager', active: false })
    assert.equal(ownerEdit.status, 200)
  } finally {
    server?.closeAllConnections(); server?.close()
    identityServer?.closeAllConnections?.(); identityServer?.close()
    await database.close()
    await db.end()
  }
})
