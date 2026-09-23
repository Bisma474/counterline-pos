import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { chromium, expect as baseExpect } from '@playwright/test'

// End-to-end verification that the cashier terminal's Inventory screen lets any logged-in
// employee view stock/movement history, but only lets a stock adjustment go through once a
// manager approves it by PIN — same PGlite + fixture pattern and demo catalog (Ceramic Mug) as
// terminal-manager-refund-browser-check.ts.

const root = fileURLToPath(new URL('../../../', import.meta.url))
const pictures = root + 'docs/screenshots/terminal-manager-inventory/'
const expect = baseExpect.configure({ timeout: 20_000 })
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
process.env.SUPABASE_URL = 'http://127.0.0.1:3295'
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
await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture Terminal Inventory Store','terminal-inventory-browser',$2)", [store, owner])
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
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3294', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${ownerToken}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(ownerUser) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner', user_id: owner, active: true, joined_at: new Date().toISOString() }]) })
identity.get('/rest/v1/profiles', (_req, res) => { res.json([{ id: owner, full_name: 'Fixture Owner' }]) })
identity.get('/rest/v1/stores', (req, res) => { const row = { id: store, name: 'Fixture Terminal Inventory Store', onboarding_completed_at: new Date().toISOString() }; res.json(String(req.headers.accept).includes('vnd.pgrst.object') ? row : [row]) })
const identityServer = identity.listen(3295, '127.0.0.1')

const web = express()
web.use('/api', createApp({ pool: db, origin: 'http://127.0.0.1:3294', supabaseUrl: 'http://127.0.0.1:3295', supabaseKey: 'fixture', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile('index.html', { root: join(root, 'apps/web/dist') }) })
const webServer = web.listen(3294, '127.0.0.1')

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
    cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3295',
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
  const headers = { Origin: 'http://127.0.0.1:3294', Authorization: `Bearer ${ownerToken}` }
  const api = (path: string, method: string, data?: object) => context.request.fetch(`http://127.0.0.1:3294/api${path}`, { method, headers, data })

  // 1. Owner creates a cashier and a PIN-based manager (terminal_employees, not a web account).
  const cashier = await api('/terminal-auth/employees', 'POST', { store_id: store, name: 'Riley Cashier', pin: '111111', role: 'cashier', active: true })
  assert.equal(cashier.status(), 201)
  const manager = await api('/terminal-auth/employees', 'POST', { store_id: store, name: 'Morgan Manager', pin: '222222', role: 'manager', active: true })
  assert.equal(manager.status(), 201)

  // 2. Provision this browser as a terminal (owner web session), then log in as the cashier.
  await page.goto('http://127.0.0.1:3294/settings/terminals')
  await page.getByLabel('Terminal name', { exact: true }).fill('Front Counter')
  await page.getByRole('button', { name: 'Provision this browser', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'This browser is provisioned' })).toBeVisible()
  await page.goto('http://127.0.0.1:3294/pos/login')
  await page.getByLabel('Select employee').selectOption({ label: 'Riley Cashier · cashier' })
  for (const digit of '111111') await page.getByRole('button', { name: digit, exact: true }).click()
  await page.getByRole('button', { name: 'Unlock POS', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Current Sale' })).toBeVisible({ timeout: 10_000 })

  // 3. Cashier opens Inventory from the terminal nav — read access requires no manager PIN.
  await page.goto('http://127.0.0.1:3294/pos/inventory')
  await expect(page.getByRole('heading', { name: 'Inventory operations.' })).toBeVisible()
  await expect(page.getByText('Ceramic Mug')).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: `${pictures}terminal-inventory-list-1440.png`, fullPage: true })

  // 4. Cashier opens the Ceramic Mug drawer and fills out an adjustment — submitting requires
  //    manager approval, not a direct save (unlike the web dashboard).
  await page.locator('.inv-row', { hasText: 'Ceramic Mug' }).getByRole('button', { name: 'Adjust' }).click()
  await expect(page.getByRole('heading', { name: 'Ceramic Mug' })).toBeVisible()
  await page.getByRole('button', { name: '+', exact: true }).click()
  await page.locator('.inv-magnitude-input').fill('5')
  await page.selectOption('#adj-reason', 'received')
  await page.getByLabel('Note').fill('New shipment received at the counter.')
  await page.screenshot({ path: `${pictures}terminal-inventory-adjust-form-1440.png`, fullPage: true })
  await page.getByRole('button', { name: 'Get manager approval' }).click()

  // 5. A manager PIN is required to actually commit the adjustment.
  await expect(page.getByRole('heading', { name: 'Authorize this stock adjustment' })).toBeVisible()
  await page.screenshot({ path: `${pictures}terminal-inventory-approval-modal-1440.png`, fullPage: true })
  for (const digit of '222222') await page.getByRole('button', { name: digit, exact: true }).click()
  const adjustResponse = page.waitForResponse(response => response.url().includes('/pos/inventory/adjust') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Approve adjustment' }).click()
  const adjustResult = await adjustResponse
  assert.equal(adjustResult.status(), 201, 'POST /pos/inventory/adjust should return 201 on success')
  await expect(page.getByText(/^Saved: \d+ → \d+\.$/)).toBeVisible()
  await page.screenshot({ path: `${pictures}terminal-inventory-adjust-complete-1440.png`, fullPage: true })

  // 6. Verify server-side: the movement is attributed to the approving terminal manager, not the
  //    cashier who filled out the form and not a web user.
  const movementRow = await database.query<{ actor_id: string | null; actor_employee_id: string | null; delta: number }>(
    "select actor_id, actor_employee_id, delta from public.pos_inventory_movements where store_id=$1 and reason='manual_adjustment' order by server_received_at desc limit 1", [store])
  assert.equal(movementRow.rows.length, 1)
  assert.equal(movementRow.rows[0].actor_id, null, 'a terminal-made adjustment must not carry a web-session actor_id')
  assert.equal(movementRow.rows[0].actor_employee_id, (await manager.json() as { id: string }).id, 'the movement must record the approving terminal manager, not the cashier who filled the form')
  assert.equal(movementRow.rows[0].delta, 5)

  console.log('PASS: a cashier browsed inventory and filled out a stock adjustment from the terminal, and a PIN-based terminal manager approved it, through the actual UI.')
} finally {
  await browser?.close(); webServer.closeAllConnections(); identityServer.closeAllConnections(); webServer.close(); identityServer.close(); await database.close(); await db.end()
}
