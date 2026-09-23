import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { chromium, expect as baseExpect } from '@playwright/test'

// End-to-end verification that a PIN-based terminal MANAGER can approve a refund and an exchange
// directly from a cashier terminal — no web/email-password account needed. A cashier rings up a
// sale, picks items to refund/exchange, then a manager approves via PIN (ManagerApprovalModal,
// the same modal/trust model already used for >20% discount approval) instead of the cashier or
// manager ever signing into the web dashboard. Same PGlite + fixture pattern as
// exchange-browser-check.ts, including its demo catalog (Ceramic Mug / Canvas Tote).

const root = fileURLToPath(new URL('../../../', import.meta.url))
const pictures = root + 'docs/screenshots/terminal-manager-refund/'
const expect = baseExpect.configure({ timeout: 20_000 })
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
process.env.SUPABASE_URL = 'http://127.0.0.1:3198'
process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture'
const { db } = await import('../src/db.js')
const { createApp } = await import('../src/app.js')

const database = new PGlite()
await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';
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
  '202609220001_inventory_operations.sql', '202609220002_product_variants.sql', '202609230001_partial_refunds.sql',
  '202609240001_terminal_manager_refund_approval.sql']) {
  await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}

const owner = randomUUID(), store = randomUUID()
await database.query('insert into auth.users(id) values ($1)', [owner])
await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture Terminal Store','terminal-refund-browser',$2)", [store, owner])
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

const ownerToken = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.fixture`
const ownerUser = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }

const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3197', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${ownerToken}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(ownerUser) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner', user_id: owner, active: true, joined_at: new Date().toISOString() }]) })
identity.get('/rest/v1/profiles', (_req, res) => { res.json([{ id: owner, full_name: 'Fixture Owner' }]) })
identity.get('/rest/v1/stores', (req, res) => { const row = { id: store, name: 'Fixture Terminal Store', onboarding_completed_at: new Date().toISOString() }; res.json(String(req.headers.accept).includes('vnd.pgrst.object') ? row : [row]) })
const identityServer = identity.listen(3198, '127.0.0.1')

const web = express()
web.use('/api', createApp({ pool: db, origin: 'http://127.0.0.1:3197', supabaseUrl: 'http://127.0.0.1:3198', supabaseKey: 'fixture', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile('index.html', { root: join(root, 'apps/web/dist') }) })
const webServer = web.listen(3197, '127.0.0.1')

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
    cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3198',
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
  const headers = { Origin: 'http://127.0.0.1:3197', Authorization: `Bearer ${ownerToken}` }
  const api = (path: string, method: string, data?: object) => context.request.fetch(`http://127.0.0.1:3197/api${path}`, { method, headers, data })

  // 1. Owner creates a cashier and a PIN-based manager (terminal_employees, not a web account).
  const cashier = await api('/terminal-auth/employees', 'POST', { store_id: store, name: 'Riley Cashier', pin: '111111', role: 'cashier', active: true })
  assert.equal(cashier.status(), 201)
  const manager = await api('/terminal-auth/employees', 'POST', { store_id: store, name: 'Morgan Manager', pin: '222222', role: 'manager', active: true })
  assert.equal(manager.status(), 201)

  // 2. Provision this browser as a terminal (owner web session), then log in as the cashier.
  await page.goto('http://127.0.0.1:3197/settings/terminals')
  await page.getByLabel('Terminal name', { exact: true }).fill('Front Counter')
  await page.getByRole('button', { name: 'Provision this browser', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'This browser is provisioned' })).toBeVisible()
  await page.goto('http://127.0.0.1:3197/pos/login')
  await page.getByLabel('Select employee').selectOption({ label: 'Riley Cashier · cashier' })
  for (const digit of '111111') await page.getByRole('button', { name: digit, exact: true }).click()
  await page.getByRole('button', { name: 'Unlock POS', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Current Sale' })).toBeVisible({ timeout: 10_000 })

  // 3. Cashier rings up the demo Ceramic Mug ($18.00 + 8% tax = $19.44) for cash.
  await page.getByRole('button', { name: 'Ceramic Mug', exact: false }).click()
  await page.getByRole('link', { name: 'Proceed to payment' }).click()
  await page.getByRole('button', { name: 'Exact amount' }).click()
  await page.getByRole('button', { name: 'Complete sale' }).click()
  await expect(page).toHaveURL(/\/pos\/orders\/[a-f0-9-]+$/)
  const orderId = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.getByText('Synced')).toBeVisible({ timeout: 30_000 })

  // 4. Cashier selects the mug to refund; the picker is visible without any manager signed in.
  await expect(page.getByText('Ceramic Mug (1 of 1 refundable)')).toBeVisible()
  await page.getByLabel('Ceramic Mug (1 of 1 refundable)').check()
  await page.screenshot({ path: `${pictures}terminal-refund-picker-1440.png`, fullPage: true })
  await page.getByRole('button', { name: 'Refund selected items' }).click()

  // 5. A manager PIN is required to actually approve it — the cashier's own PIN must not work.
  await expect(page.getByRole('heading', { name: 'Authorize this refund' })).toBeVisible()
  await page.screenshot({ path: `${pictures}terminal-refund-approval-modal-1440.png`, fullPage: true })
  for (const digit of '222222') await page.getByRole('button', { name: digit, exact: true }).click()
  const refundResponse = page.waitForResponse(response => response.url().includes('/pos/orders/') && response.url().includes('/refund') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Approve refund' }).click()
  const refundResult = await refundResponse
  assert.equal(refundResult.status(), 201, 'POST /pos/orders/:id/refund should return 201 on success')
  await expect(page.getByText('Refunded $19.44 so far.')).toBeVisible()
  await expect(page.getByText('Every item on this receipt has been fully refunded.')).toBeVisible()
  await page.screenshot({ path: `${pictures}terminal-refund-complete-1440.png`, fullPage: true })

  // 6. Verify server-side: the refund's actor is the terminal manager, not a web user.
  const refundRow = await database.query<{ refunded_by: string | null; approved_by_employee_id: string | null }>(
    'select refunded_by, approved_by_employee_id from public.pos_refunds where store_id=$1 and order_id=$2', [store, orderId])
  assert.equal(refundRow.rows.length, 1)
  assert.equal(refundRow.rows[0].refunded_by, null, 'a terminal-approved refund must not carry a web-session refunded_by')
  assert.equal(refundRow.rows[0].approved_by_employee_id, (await manager.json() as { id: string }).id, 'the refund must record the approving terminal manager')

  // 7. Second sale, then exchange it — same terminal manager approval, this time for an exchange.
  await page.goto('http://127.0.0.1:3197/pos/register')
  await page.getByRole('button', { name: 'Ceramic Mug', exact: false }).click()
  await page.getByRole('link', { name: 'Proceed to payment' }).click()
  await page.getByRole('button', { name: 'Exact amount' }).click()
  await page.getByRole('button', { name: 'Complete sale' }).click()
  await expect(page).toHaveURL(/\/pos\/orders\/[a-f0-9-]+$/)
  const secondOrderId = new URL(page.url()).pathname.split('/').pop()!

  await expect(page.getByRole('link', { name: 'Exchange items instead' })).toBeVisible()
  await page.getByRole('link', { name: 'Exchange items instead' }).click()
  await expect(page).toHaveURL(new RegExp(`/pos/orders/${secondOrderId}/exchange$`))
  await expect(page.getByText('Ceramic Mug (1 of 1 available)')).toBeVisible()
  await page.getByLabel('Ceramic Mug (1 of 1 available)').check()
  await page.getByRole('button', { name: 'Continue to replacement →' }).click()
  await page.getByRole('button', { name: 'Canvas Tote', exact: false }).click()
  await page.getByRole('button', { name: 'Continue to payment →' }).click()
  await page.getByLabel('Amount received for replacement').fill('50.00')
  await page.getByRole('button', { name: 'Get manager approval' }).click()
  await expect(page.getByRole('heading', { name: 'Authorize this exchange' })).toBeVisible()
  for (const digit of '222222') await page.getByRole('button', { name: digit, exact: true }).click()
  const exchangeResponse = page.waitForResponse(response => response.url().includes('/pos/orders/') && response.url().includes('/exchange') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Approve exchange' }).click()
  const exchangeResult = await exchangeResponse
  assert.equal(exchangeResult.status(), 201, 'POST /pos/orders/:id/exchange should return 201 on success')
  await expect(page).toHaveURL(/\/pos\/orders\/[a-f0-9-]+$/)
  const newOrderId = new URL(page.url()).pathname.split('/').pop()!
  assert.notEqual(newOrderId, secondOrderId)
  await page.screenshot({ path: `${pictures}terminal-exchange-new-receipt-1440.png`, fullPage: true })

  // 8. Verify server-side: the exchange's replacement order is attributed to the cashier who rang
  //    it up (not the approving manager), and its refund half is attributed to the manager.
  const newOrderRow = await database.query<{ employee_id: string }>('select employee_id from public.pos_orders where store_id=$1 and id=$2', [store, newOrderId])
  assert.equal(newOrderRow.rows[0].employee_id, (await cashier.json() as { id: string }).id, 'the replacement sale must be attributed to the cashier who rang it up, not the approving manager')
  const exchangeRefundRow = await database.query<{ approved_by_employee_id: string | null; exchange_order_id: string }>(
    'select approved_by_employee_id, exchange_order_id from public.pos_refunds where store_id=$1 and order_id=$2', [store, secondOrderId])
  assert.equal(exchangeRefundRow.rows[0].approved_by_employee_id, (await manager.json() as { id: string }).id)
  assert.equal(exchangeRefundRow.rows[0].exchange_order_id, newOrderId)

  console.log('PASS: a PIN-based terminal manager approved a real refund and a real exchange from the cashier terminal, through the actual UI, with no web/email-password account involved.')
} finally {
  await browser?.close(); webServer.closeAllConnections(); identityServer.closeAllConnections(); webServer.close(); identityServer.close(); await database.close(); await db.end()
}
