import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { chromium, expect as baseExpect } from '@playwright/test'

// End-to-end verification for the three inventory fixes on this branch:
//   1. A sale that would oversell a product is rejected by the API (direct check — the
//      cart/checkout UI itself isn't part of this branch's changes).
//   2. A manual stock adjustment that would drive stock negative requires an explicit
//      confirmation in the actual Adjust drawer before it's submitted.
//   3. The search/category/status-filter toolbar is hidden while actively counting (it was
//      previously visible but inert there), and remains functional in the list and
//      cycle-count "start" steps.
// Follows the refund-browser-check.ts pattern: an in-memory Postgres with the real
// migrations applied, faked Supabase auth, and the actual built web app served locally.

const root = fileURLToPath(new URL('../../../', import.meta.url))
const pictures = root + 'docs/screenshots/inventory/'
const expect = baseExpect.configure({ timeout: 20_000 })
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
process.env.SUPABASE_URL = 'http://127.0.0.1:3293'
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
// Same curated, fresh-DB-compatible migration set as inventory-api.test.ts's MIGRATIONS list —
// deliberately excludes fix-up-only migrations (e.g. 202609180006_stores_country_column.sql)
// that assume a drifted, already-deployed database and conflict on a truly fresh one.
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
]
for (const name of MIGRATIONS) {
  await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}

const owner = randomUUID(), store = randomUUID(), device = randomUUID()
const productA = randomUUID(), productB = randomUUID(), productC = randomUUID()
await database.query('insert into auth.users(id) values ($1)', [owner])
await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture Inventory Store','inventory-browser',$2)", [store, owner])
await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'owner')", [store, owner])
await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values
  ($1,$4,'TOTE-001','Canvas Tote',1800),
  ($2,$4,'MUG-001','Ceramic Mug',1200),
  ($3,$4,'CNDL-001','Soy Candle',1500)`, [productA, productB, productC, store])
await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,3),($1,$3,20),($1,$4,0)', [store, productA, productB, productC])
const { createHash } = await import('node:crypto')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const deviceAccess = 'a'.repeat(64)
await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
  values ($1,$2,'Counter','INV-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
  [device, store, owner, digest('c'.repeat(64)), digest(deviceAccess)])
await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
  values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(deviceAccess), digest('d'.repeat(64))])

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
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3292', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => {
  const auth = req.headers.authorization
  if (auth === `Bearer ${ownerToken}`) { (req as unknown as { fixtureUser: typeof ownerUser }).fixtureUser = ownerUser; next(); return }
  res.sendStatus(401)
})
identity.get('/auth/v1/user', (req, res) => { res.json((req as unknown as { fixtureUser: typeof ownerUser }).fixtureUser) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner', user_id: owner, active: true, joined_at: new Date().toISOString() }]) })
identity.get('/rest/v1/profiles', (_req, res) => { res.json([{ id: owner, full_name: 'Fixture Owner' }]) })
identity.get('/rest/v1/stores', (req, res) => { const row = { id: store, name: 'Fixture Inventory Store', onboarding_completed_at: new Date().toISOString() }; res.json(String(req.headers.accept).includes('vnd.pgrst.object') ? row : [row]) })
const identityServer = identity.listen(3293, '127.0.0.1')

const web = express()
web.use('/api', createApp({ pool: db, origin: 'http://127.0.0.1:3292', supabaseUrl: 'http://127.0.0.1:3293', supabaseKey: 'fixture', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile('index.html', { root: join(root, 'apps/web/dist') }) })
const webServer = web.listen(3292, '127.0.0.1')

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
    cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3293',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'fixture', VITE_API_URL: '/api' }, stdio: 'inherit', windowsHide: true })
  assert.equal(await new Promise<number | null>(resolve => build.on('exit', resolve)), 0)
  await mkdir(pictures, { recursive: true })
  browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }))
  }, { token: ownerToken, user: ownerUser })
  const page = await context.newPage()
  page.on('dialog', dialog => void dialog.accept())
  page.on('response', response => { if (response.status() >= 400 && response.status() !== 401 && response.status() !== 422 && response.status() !== 409) console.log('API response:', response.status(), new URL(response.url()).pathname) })

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 1. Oversell is rejected at the API (Fix 1). No cart UI exists for the checkout path on
  //    this branch's owner-side screens, so this hits POST /pos/orders/push directly — the
  //    same request shape the terminal/register flow sends — proving the server-side guard.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  {
    const operationId = randomUUID()
    const oversellBody = {
      operation_id: operationId,
      order: { id: operationId, store_id: store, receipt_number: 'INV-000001', catalog_version: 1,
        client_generated_at: new Date().toISOString(), subtotal_cents: 1800 * 10, discount_cents: 0, tax_cents: 0, total_cents: 1800 * 10,
        customer_id: null, employee_id: null, manager_id: null, manager_approved_at: null },
      items: [{ id: randomUUID(), product_id: productA, snapshot_name: 'Canvas Tote', snapshot_sku: 'TOTE-001',
        snapshot_price_cents: 1800, snapshot_tax_bps: 0, catalog_version: 1, quantity: 10,
        discount_kind: null, discount_value: null, subtotal_cents: 1800 * 10, discount_applied_cents: 0, taxable_cents: 1800 * 10, tax_cents: 0, total_cents: 1800 * 10 }],
      payment: { id: randomUUID(), method: 'cash', amount_cents: 1800 * 10, tendered_cents: 1800 * 10, change_cents: 0, reference: null },
    }
    const oversellResp = await fetch('http://127.0.0.1:3292/api/pos/orders/push', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3292', Cookie: `terminal_access=${deviceAccess}` }, body: JSON.stringify(oversellBody),
    })
    assert.equal(oversellResp.status, 409, 'A 10-unit sale against 3 units of stock must be rejected as insufficient_stock')
    const oversellJson = await oversellResp.json() as { code: string }
    assert.equal(oversellJson.code, 'insufficient_stock')
    const stockAfter = await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productA])
    assert.equal(stockAfter.rows[0].current_stock, 3, 'Stock must be untouched after a rejected oversell attempt')
    console.log(`PASS (1/3): oversell rejected — POST /pos/orders/push returned 409 insufficient_stock, stock unchanged at 3.`)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 2. Manual adjustment confirmation guard (Fix 2), driven through the real Adjust drawer.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  await page.goto('http://127.0.0.1:3292/inventory')
  await expect(page.getByRole('heading', { name: 'Inventory operations.' })).toBeVisible()
  await expect(page.getByText('Canvas Tote')).toBeVisible()

  const toteRow = page.locator('.inv-row', { hasText: 'Canvas Tote' })
  await toteRow.getByRole('button', { name: 'Adjust' }).click()
  await expect(page.getByRole('dialog', { name: 'Inventory for Canvas Tote' })).toBeVisible()

  // Decrease by 15 against 3 in stock -> would land on -12. First click must show the inline
  // confirmation and NOT submit; the button label must change to "Confirm adjustment".
  await page.locator('.inv-sign-btn.decrease').click()
  await page.locator('.inv-magnitude-input').fill('15')
  await page.getByLabel('Reason').selectOption({ label: 'Damaged' })
  await page.getByLabel('Note').fill('Browser-check: confirming the negative-adjustment guard.')

  const saveButton = page.locator('.pc-drawer-foot .pc-submit')
  await expect(saveButton).toHaveText('Save adjustment')
  await saveButton.click()
  await expect(page.getByText('This will take stock to -12.')).toBeVisible()
  await expect(saveButton).toHaveText('Confirm adjustment')
  await page.screenshot({ path: `${pictures}adjust-negative-confirmation-1440.png`, fullPage: true })

  // Stock must NOT have changed yet — the first click only asked for confirmation.
  const stockBeforeConfirm = await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productA])
  assert.equal(stockBeforeConfirm.rows[0].current_stock, 3, 'Stock must not change until the confirmation click')

  const adjustResponse = page.waitForResponse(response => response.url().includes('/inventory/adjust') && response.request().method() === 'POST')
  await saveButton.click()
  const adjustResp = await adjustResponse
  assert.equal(adjustResp.status(), 201, 'The confirmed adjustment should be accepted once allow_negative is sent')
  await expect(page.getByText('Saved: 3 → -12.')).toBeVisible()
  const stockAfterConfirm = await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productA])
  assert.equal(stockAfterConfirm.rows[0].current_stock, -12, 'Stock should now be -12, matching the confirmed adjustment')
  console.log('PASS (2/3): negative manual adjustment required an explicit confirmation click before it was submitted; stock landed at -12 as expected.')
  await page.locator('.pc-drawer-close').click()

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 3. Dead filter toolbar during active cycle counting (Fix 3).
  // ═══════════════════════════════════════════════════════════════════════════════════════
  // In the plain list view, the toolbar (search/category/status pills) must be visible and the
  // status pills must actually filter the table.
  await expect(page.locator('.inv-state-filters')).toBeVisible()
  await page.locator('.inv-state-filters .inv-state-pill', { hasText: 'Out' }).click()
  await expect(page.getByText('Soy Candle')).toBeVisible()
  await expect(page.getByText('Canvas Tote')).toHaveCount(0)
  await page.locator('.inv-state-filters .inv-state-pill', { hasText: 'All' }).click()
  await expect(page.getByText('Canvas Tote')).toBeVisible()

  // Start a cycle count: the picker step ("start") must still show the toolbar.
  await page.getByRole('button', { name: 'Start cycle count' }).click()
  await expect(page.getByText('Select all')).toBeVisible()
  await expect(page.locator('.inv-state-filters')).toBeVisible({ timeout: 5000 })
  await page.getByLabel('Select all filtered products').check()
  await page.getByRole('button', { name: /Begin count/ }).click()

  // Now actively counting: Product/Expected/Counted/Variance/Status table is up, and the
  // shared toolbar (search box, category select, status pills) must be gone entirely — it was
  // previously left visible here despite doing nothing when clicked.
  await expect(page.getByText('Expected').first()).toBeVisible()
  await expect(page.getByText('Counted').first()).toBeVisible()
  await expect(page.locator('.inv-state-filters')).toHaveCount(0, { timeout: 5000 })
  await expect(page.locator('.pc-toolbar')).toHaveCount(0)
  await page.screenshot({ path: `${pictures}cycle-count-toolbar-hidden-1440.png`, fullPage: true })
  console.log('PASS (3/3): status/search/category toolbar is visible and functional in the list and cycle-count "start" steps, and hidden during active counting.')

  // Clean up the in-progress session so this script leaves no dangling state.
  await page.getByRole('button', { name: 'Cancel count' }).click()
  await expect(page.getByText('Cycle count cancelled.')).toBeVisible()

  console.log('ALL PASS: oversell blocked, negative-adjustment confirmation enforced, cycle-count toolbar correctly scoped.')
} finally {
  await browser?.close(); webServer.closeAllConnections(); identityServer.closeAllConnections(); webServer.close(); identityServer.close(); await database.close(); await db.end()
}
