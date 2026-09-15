// Real terminal API + committed SQL migrations. Only Supabase's identity/REST boundary
// is replaced by a local fixture. No live account or store data is used.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { chromium, expect as baseExpect } from '@playwright/test'
import { createApp } from '../src/app.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const expect = baseExpect.configure({ timeout: 20_000 })
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
await db.exec((await readFile(root + 'supabase/migrations/202609130001_auth_and_stores.sql', 'utf8')).replace('create extension if not exists pgcrypto;', ''))
await db.exec(await readFile(root + 'supabase/migrations/202609150001_terminal_employee_access.sql', 'utf8'))
const owner = randomUUID(), store = randomUUID()
await db.query('insert into auth.users(id) values($1)', [owner])
await db.query("insert into public.stores(id,name,code,created_by) values($1,'Demo General','browser-test',$2)", [store, owner])
await db.query("insert into public.store_memberships(store_id,user_id,role) values($1,$2,'owner')", [store, owner])
let tail = Promise.resolve()
const pool = { async connect() {
  const previous = tail; let release!: () => void
  tail = new Promise<void>(resolve => { release = resolve }); await previous
  return { query: async (sql: string, values?: unknown[]) => {
    const result = await db.query(sql, values)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }, release }
} } as unknown as Pool
const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
const accessToken = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.test-signature`
const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3178', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${accessToken}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(user) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner' }]) })
identity.get('/rest/v1/stores', (_req, res) => { res.json([{ id: store, name: 'Demo General' }]) })
const identityServer = identity.listen(3179, '127.0.0.1')
const web = express()
web.use('/api', createApp({ pool, origin: 'http://127.0.0.1:3178', supabaseUrl: 'http://127.0.0.1:3179', supabaseKey: 'test-publishable', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile(root + 'apps/web/dist/index.html') })
const server = web.listen(3178, '127.0.0.1')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], { cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3179', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable' }, stdio: 'inherit', windowsHide: true })
  assert.equal(await new Promise<number | null>(resolve => build.on('exit', resolve)), 0)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  // Keep this local test independent of external font/CDN availability.
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.addInitScript(({ accessToken, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: accessToken, refresh_token: 'test-owner-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }))
  }, { accessToken, user })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('requestfailed', request => console.log('Browser request failed:', new URL(request.url()).pathname, request.failure()?.errorText))
  page.on('response', response => { if (response.status() >= 400) console.log('Browser response:', response.status(), new URL(response.url()).pathname) })
  await page.goto('http://127.0.0.1:3178/settings/employees', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Cashier access.' })).toBeVisible()
  await expect(page.getByLabel('Cashier name')).toBeEnabled({ timeout: 30_000 })
  const pin = String(100000 + Math.floor(Math.random() * 900000))
  await page.getByLabel('Cashier name').fill('Alex Rivera')
  await page.getByLabel('PIN', { exact: true }).fill(pin)
  await page.getByRole('button', { name: 'Create employee' }).click()
  await expect(page.getByRole('button', { name: 'Edit Alex Rivera' })).toBeVisible()
  const screenshots = root + 'docs/terminal-access/screenshots/'
  await mkdir(screenshots, { recursive: true })
  for (const width of [1440, 390, 375, 768]) {
    await page.setViewportSize({ width, height: 1000 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    if (width === 1440 || width === 390) await page.screenshot({ path: `${screenshots}employees-${width}.png`, fullPage: true })
  }
  await page.getByRole('link', { name: 'Terminals', exact: true }).click()
  await page.getByLabel('Terminal name').fill('Front counter')
  await page.getByRole('button', { name: 'Provision this browser' }).click()
  await expect(page.getByText('This browser is provisioned.', { exact: false })).toBeVisible()
  for (const width of [1440, 390, 375, 768]) {
    await page.setViewportSize({ width, height: 1000 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    if (width === 1440 || width === 390) await page.screenshot({ path: `${screenshots}terminals-${width}.png`, fullPage: true })
  }
  await page.getByRole('link', { name: 'Cashier sign in' }).click()
  await expect(page.getByRole('combobox', { name: 'Employee', exact: true })).toBeEnabled()
  await page.getByRole('combobox', { name: 'Employee', exact: true }).selectOption({ label: 'Alex Rivera' })
  for (const width of [1440, 390, 375, 768]) {
    await page.setViewportSize({ width, height: 1000 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    if (width === 1440 || width === 390) await page.screenshot({ path: `${screenshots}cashier-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 390, height: 1000 })
  await page.getByLabel('PIN', { exact: true }).fill(pin)
  await page.getByRole('button', { name: 'Unlock terminal' }).click()
  await expect(page.getByRole('heading', { name: 'PIN access granted.' })).toBeVisible()
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  // Reopen offline from the cached production shell and retained IndexedDB.
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'PIN access granted.' })).toBeVisible()
  await page.getByRole('button', { name: 'Lock terminal', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Employee', exact: true })).toBeEnabled()
  await page.getByRole('combobox', { name: 'Employee', exact: true }).selectOption({ label: 'Alex Rivera' })
  const wrongPin = String((Number(pin) + 1) % 1000000).padStart(6, '0')
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.getByLabel('PIN', { exact: true }).fill(wrongPin)
    await page.getByRole('button', { name: 'Unlock terminal' }).click()
    await expect(page.getByRole('alert')).toContainText('PIN not accepted')
    await expect(page.getByRole('button', { name: 'Unlock terminal' })).toBeEnabled()
  }
  await page.reload()
  await page.getByRole('combobox', { name: 'Employee', exact: true }).selectOption({ label: 'Alex Rivera' })
  await page.getByLabel('PIN', { exact: true }).fill(pin)
  await page.getByRole('button', { name: 'Unlock terminal' }).click()
  await expect(page.getByRole('alert')).toContainText('PIN access is locked')
  await page.screenshot({ path: `${screenshots}offline-lockout-390.png`, fullPage: true })
  // Advance the test clock past lockout, preserving the authorization window.
  await page.clock.install({ time: Date.now() + 61_000 })
  await page.getByLabel('PIN', { exact: true }).fill(pin)
  await page.getByRole('button', { name: 'Unlock terminal' }).click()
  await expect(page.getByRole('heading', { name: 'PIN access granted.' })).toBeVisible()
  await page.clock.setSystemTime(Date.now() - 60_000)
  await page.clock.runFor(6000)
  await expect(page.getByRole('combobox', { name: 'Employee', exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Employee', exact: true }).selectOption({ label: 'Alex Rivera' })
  await page.getByLabel('PIN', { exact: true }).fill(pin)
  await page.getByRole('button', { name: 'Unlock terminal' }).click()
  await expect(page.getByRole('alert')).toContainText('clock moved backwards')
  await page.clock.setSystemTime(Date.now())
  await context.setOffline(false)
  await expect(page.getByRole('button', { name: 'Refresh terminal access' })).toBeEnabled()
  await page.getByRole('button', { name: 'Refresh terminal access' }).click()
  await expect(page.getByRole('combobox', { name: 'Employee', exact: true })).toBeEnabled()
  await expect(page.getByRole('heading', { name: 'PIN access granted.' })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Employee', exact: true }).selectOption({ label: 'Alex Rivera' })
  await page.getByLabel('PIN', { exact: true }).fill(pin)
  await page.getByRole('button', { name: 'Unlock terminal' }).click()
  await expect(page.getByRole('heading', { name: 'PIN access granted.' })).toBeVisible()
  const employee = await db.query<{ id: string }>('select id from public.terminal_employees where store_id=$1', [store])
  const changed = await context.request.post('http://127.0.0.1:3178/api/terminal-auth/employees', { headers: { Origin: 'http://127.0.0.1:3178', Authorization: `Bearer ${accessToken}` }, data: { id: employee.rows[0].id, store_id: store, name: 'Alex Rivera', role: 'cashier', active: false } })
  assert.equal(changed.status(), 200)
  await page.getByRole('button', { name: 'Refresh terminal access' }).click()
  await expect(page.getByText('No cached employees are available.', { exact: false })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'PIN access granted.' })).toHaveCount(0)
  assert.deepEqual(errors, [])
  console.log('PASS: manager employee setup, provisioning, online PIN login, all new screens at 375/390/768/1440, offline reload/unlock, persisted lockout, clock rollback, no session resurrection after local lock, connected deactivation. Screenshots saved.')
} finally {
  await browser?.close()
  server.closeAllConnections(); identityServer.closeAllConnections(); server.close(); identityServer.close(); await db.close()
}
