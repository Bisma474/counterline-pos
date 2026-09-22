import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { chromium, expect as baseExpect } from '@playwright/test'

// End-to-end verification for the exchange workflow — real cash sale, real Receipt-screen
// "Exchange items instead" entry point, real return-item picker, real replacement-product picker,
// real payment collection, through the actual built UI. Same PGlite + faked-Supabase-auth pattern
// as refund-browser-check.ts, including its demo catalog (Ceramic Mug / Canvas Tote), since this
// branch's migration list doesn't remove the demo-seed trigger.

const root = fileURLToPath(new URL('../../../', import.meta.url))
const pictures = root + 'docs/screenshots/exchanges/'
const expect = baseExpect.configure({ timeout: 20_000 })
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
process.env.SUPABASE_URL = 'http://127.0.0.1:3196'
process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture'
const { db } = await import('../src/db.js')
const { createApp } = await import('../src/app.js')

const database = new PGlite()
await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';
  -- Minimal storage schema stub: PGlite has no Supabase Storage extension, but the product-images
  -- migration expects storage.buckets/storage.objects/storage.foldername() to exist.
  create schema storage;
  create table storage.buckets(id text primary key, name text, public boolean);
  create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  create function storage.foldername(name text) returns text[] language sql as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;`)
for (const name of ['202609130001_auth_and_stores.sql', '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql', '202609150002_terminal_device_sessions.sql',
  '202609160001_customers_and_sale_attachment.sql', '202609170001_change_feed_product_entity.sql',
  '202609170002_cart_discounts.sql', '202609180001_terminal_name_uniqueness.sql',
  '202609180002_pos_orders_report_read_access.sql',
  '202609180002_store_business_details.sql', '202609180003_tax_rate_change_feed.sql',
  '202609180004_product_images.sql', '202609180005_refunds.sql', '202609190001_audit_log.sql',
  '202609220001_inventory_operations.sql', '202609220002_product_variants.sql', '202609230001_partial_refunds.sql']) {
  await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}

const owner = randomUUID(), store = randomUUID()
await database.query('insert into auth.users(id) values ($1)', [owner])
await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture Exchange Store','exchange-browser',$2)", [store, owner])
await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'owner')", [store, owner])

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

function fixtureToken(userId: string) {
  return `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.fixture`
}
const ownerToken = fixtureToken(owner)
const ownerUser = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }

const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3195', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => {
  const auth = req.headers.authorization
  if (auth === `Bearer ${ownerToken}`) { (req as unknown as { fixtureUser: typeof ownerUser }).fixtureUser = ownerUser; next(); return }
  res.sendStatus(401)
})
identity.get('/auth/v1/user', (req, res) => { res.json((req as unknown as { fixtureUser: typeof ownerUser }).fixtureUser) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner', user_id: owner, active: true, joined_at: new Date().toISOString() }]) })
identity.get('/rest/v1/profiles', (_req, res) => { res.json([{ id: owner, full_name: 'Fixture Owner' }]) })
identity.get('/rest/v1/stores', (req, res) => { const row = { id: store, name: 'Fixture Exchange Store', onboarding_completed_at: new Date().toISOString() }; res.json(String(req.headers.accept).includes('vnd.pgrst.object') ? row : [row]) })
const identityServer = identity.listen(3196, '127.0.0.1')

const web = express()
web.use('/api', createApp({ pool: db, origin: 'http://127.0.0.1:3195', supabaseUrl: 'http://127.0.0.1:3196', supabaseKey: 'fixture', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile('index.html', { root: join(root, 'apps/web/dist') }) })
const webServer = web.listen(3195, '127.0.0.1')

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
    cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3196',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'fixture', VITE_API_URL: '/api' }, stdio: 'inherit', windowsHide: true })
  assert.equal(await new Promise<number | null>(resolve => build.on('exit', resolve)), 0)
  await mkdir(pictures, { recursive: true })
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }))
  }, { token: ownerToken, user: ownerUser })
  const page = await context.newPage()
  page.on('dialog', dialog => void dialog.accept())
  page.on('response', response => { if (response.status() >= 400 && response.status() !== 401) console.log('API response:', response.status(), new URL(response.url()).pathname) })

  // 1. A real cash sale of the demo "Ceramic Mug" ($18.00 + 8% tax = $19.44).
  await page.goto('http://127.0.0.1:3195/register')
  await expect(page.getByRole('heading', { name: 'Current Sale' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ceramic Mug', exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Ceramic Mug', exact: false }).click()
  await page.getByRole('link', { name: 'Proceed to payment' }).click()
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
  await page.getByLabel('Amount received').fill('20.00')
  await page.getByRole('button', { name: 'Complete sale' }).click()
  await expect(page.getByRole('heading', { name: 'Receipt.' })).toBeVisible()
  const orderId = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.getByText('Synced')).toBeVisible({ timeout: 30_000 })

  const mugStockBefore = await database.query<{ current_stock: number }>(
    "select current_stock from public.pos_stock s join public.pos_products p on p.id=s.product_id where s.store_id=$1 and p.sku='MUG-001'", [store])

  // 2. Open the exchange flow from the Receipt screen.
  await expect(page.getByRole('link', { name: 'Exchange items instead' })).toBeVisible()
  await page.getByRole('link', { name: 'Exchange items instead' }).click()
  await expect(page.getByRole('heading', { name: /Exchange receipt/ })).toBeVisible()

  // 3. Step 1: select the sold Ceramic Mug to return.
  await expect(page.getByText('Ceramic Mug (1 of 1 available)')).toBeVisible()
  await page.getByLabel('Ceramic Mug (1 of 1 available)').check()
  await page.getByRole('button', { name: 'Continue to replacement →' }).click()

  // 4. Step 2: pick a replacement product from the catalog (Canvas Tote — a different demo item,
  //    pricier than the returned mug, so this exercises the "customer owes more" direction).
  await expect(page.getByRole('heading', { name: '2. Pick replacement item(s)' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Canvas Tote', exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Canvas Tote', exact: false }).click()
  await expect(page.getByText('Customer owes')).toBeVisible()
  await page.screenshot({ path: `${pictures}exchange-pick-replacement-1440.png`, fullPage: true })
  await page.getByRole('button', { name: 'Continue to payment →' }).click()

  // 5. Step 3: collect the payment difference in cash. Canvas Tote is pricier than $20, so a
  //    generous $50 tender covers it regardless of its exact catalog price.
  await expect(page.getByRole('heading', { name: '3. Collect payment' })).toBeVisible()
  await page.getByLabel('Amount received for replacement').fill('50.00')
  const exchangeResponse = page.waitForResponse(response => response.url().includes('/exchange') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Complete exchange' }).click()
  const response = await exchangeResponse
  assert.equal(response.status(), 201, 'POST /orders/:id/exchange should return 201 on success')

  // 6. Lands on the new replacement order's own receipt.
  await expect(page.getByRole('heading', { name: 'Receipt.' })).toBeVisible()
  const newOrderId = new URL(page.url()).pathname.split('/').pop()!
  assert.notEqual(newOrderId, orderId, 'the exchange must land on the NEW replacement order receipt, not the original')
  await page.screenshot({ path: `${pictures}exchange-new-receipt-1440.png`, fullPage: true })

  // 7. Verify the transaction actually committed on both sides: original order fully refunded and
  //    restocked, new order created and decremented, linked via exchange_order_id.
  const mugStockAfter = await database.query<{ current_stock: number }>(
    "select current_stock from public.pos_stock s join public.pos_products p on p.id=s.product_id where s.store_id=$1 and p.sku='MUG-001'", [store])
  assert.equal(mugStockAfter.rows[0].current_stock, mugStockBefore.rows[0].current_stock + 1, 'the returned mug should be restocked')
  const refundRow = await database.query<{ amount_cents: string; exchange_order_id: string }>(
    'select amount_cents::text as amount_cents, exchange_order_id from public.pos_refunds where store_id=$1 and order_id=$2', [store, orderId])
  assert.equal(refundRow.rows.length, 1)
  assert.equal(refundRow.rows[0].amount_cents, '1944', 'the mug was refunded at its full original sale price')
  assert.equal(refundRow.rows[0].exchange_order_id, newOrderId, 'the refund must be linked to the new replacement order')
  const newOrderRow = await database.query('select 1 from public.pos_orders where store_id=$1 and id=$2', [store, newOrderId])
  assert.equal(newOrderRow.rowCount, 1)

  // 8. The original receipt now shows fully refunded when revisited.
  await page.goto(`http://127.0.0.1:3195/orders/${orderId}`)
  await expect(page.getByText('Refunded $19.44 so far.')).toBeVisible()
  await expect(page.getByText('Every item on this receipt has been fully refunded.')).toBeVisible()
  await page.screenshot({ path: `${pictures}exchange-original-receipt-after-1440.png`, fullPage: true })

  console.log('PASS: exchange composed a real refund + a real replacement sale through the actual UI — return picker, replacement product picker, payment collection, and both receipts all reflect the correct end state.')
} finally {
  await browser?.close(); webServer.closeAllConnections(); identityServer.closeAllConnections(); webServer.close(); identityServer.close(); await database.close(); await db.end()
}
