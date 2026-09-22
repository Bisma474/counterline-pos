import assert from 'node:assert/strict'
import { readFile, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { chromium, expect as baseExpect } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const pictures = root + 'docs/product-variants/screenshots/'
const expect = baseExpect.configure({ timeout: 20_000 })
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
process.env.SUPABASE_URL = 'http://127.0.0.1:3189'
process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture'
const { db } = await import('../src/db.js')
const { createApp } = await import('../src/app.js')

// In-memory Postgres with the real migrations applied — no real Supabase project or
// credentials required. Mirrors the pattern in customer-browser-check.ts.
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
// The country repair targets a deployed schema drift; the clean base already has that column.
for (const name of (await readdir(root + 'supabase/migrations')).filter(name=>name.endsWith('.sql') && name!=='202609180006_stores_country_column.sql').sort()) {
  await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}
const owner = randomUUID(), store = randomUUID()
await database.query('insert into auth.users(id) values ($1)', [owner])
await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture Catalog Store','catalog-browser',$2)", [store, owner])
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

const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.fixture`
const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3188', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${token}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(user) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner', user_id: owner, active: true, joined_at: new Date().toISOString() }]) })
identity.get('/rest/v1/profiles', (_req, res) => { res.json([{ id: owner, full_name: 'Fixture Owner' }]) })
// App.tsx's onboarding-status check (202609190001_store_onboarding_status.sql) reads this
// directly via the Supabase client, so the fixture must answer it or every route falls into the
// "Something needs your attention" store-load-failure screen.
// .single() calls expect a bare object in the response body, not an array wrapping one.
identity.get('/rest/v1/stores', (req, res) => { const row = { id: store, name: 'Fixture Catalog Store', onboarding_completed_at: new Date().toISOString() }; res.json(String(req.headers.accept).includes('vnd.pgrst.object') ? row : [row]) })
const identityServer = identity.listen(3189, '127.0.0.1')
const web = express()
web.use('/api', createApp({ pool: db, origin: 'http://127.0.0.1:3188', supabaseUrl: 'http://127.0.0.1:3189', supabaseKey: 'fixture', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile('index.html', { root: join(root, 'apps/web/dist') }) })
const webServer = web.listen(3188, '127.0.0.1')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath,[root+'apps/web/node_modules/vite/bin/vite.js','build'],{cwd:root+'apps/web',env:{...process.env,VITE_SUPABASE_URL:'http://127.0.0.1:3189',VITE_SUPABASE_PUBLISHABLE_KEY:'fixture',VITE_API_URL:'/api'},stdio:'inherit',windowsHide:true})
  assert.equal(await new Promise(resolve=>build.on('exit',resolve)),0)
  await mkdir(pictures,{recursive:true})
  browser=await chromium.launch({headless:true})
  const context=await browser.newContext({viewport:{width:1440,height:1000}})
  await context.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}))
  await context.route('https://fonts.gstatic.com/**',route=>route.abort())
  await context.addInitScript(({token,user})=>{
    localStorage.setItem('sb-127-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user}))
  },{token,user})
  const page=await context.newPage()
  const errors:string[]=[]
  page.on('pageerror',error=>errors.push(error.message))
  const headers={Origin:'http://127.0.0.1:3188',Authorization:`Bearer ${token}`}
  const api=async(path:string,method:string,data?:object)=>context.request.fetch(`http://127.0.0.1:3188/api${path}`,{method,headers,data})
  const normal=await api('/catalog/products','POST',{store_id:store,name:'Ordinary Mug',sku:'PLAIN',unit_price_cents:500,initial_stock:20})
  assert.equal(normal.status(),201)
  assert.equal((await api('/catalog/product-parents','POST',{store_id:randomUUID(),name:'Forbidden'})).status(),403)
  assert.equal((await context.request.post('http://127.0.0.1:3188/api/catalog/product-parents',{headers:{Origin:'http://127.0.0.1:3188'},data:{store_id:store,name:'Forbidden'}})).status(),401)
  await page.goto('http://127.0.0.1:3188/products')
  await expect(page.getByRole('heading',{name:'Product catalog.'})).toBeVisible()
  await page.getByLabel('New parent product name').fill('T-Shirt')
  await page.getByRole('button',{name:'Create parent product',exact:true}).click()
  await expect(page.getByLabel('Parent name',{exact:true})).toHaveValue('T-Shirt')
  const createVariant=async(sku:string,size:string,color:string,barcode:string,price:string,stock:string)=>{
    await page.getByLabel('Variant SKU',{exact:true}).fill(sku)
    await page.getByLabel('Variant barcode (optional)').fill(barcode)
    await page.getByLabel('Variant price (USD)').fill(price)
    await page.getByLabel('Initial variant stock').fill(stock)
    await page.getByLabel('Option 1 value').fill(size)
    await page.getByLabel('Option 2 value').fill(color)
    await page.getByRole('button',{name:'Create draft variant',exact:true}).click()
    await expect(page.getByRole('button',{name:`Activate ${sku}`,exact:true})).toBeVisible()
  }
  await createVariant('TS-S-B','Small','Black','991001','12.00','7')
  await page.getByRole('button',{name:'Activate TS-S-B',exact:true}).click()
  await expect(page.getByRole('button',{name:'Deactivate TS-S-B',exact:true})).toBeVisible()
  await createVariant('TS-L-W','Large','White','991002','15.00','9')
  await page.getByRole('button',{name:'Activate TS-L-W',exact:true}).click()
  await expect(page.getByRole('button',{name:'Deactivate TS-L-W',exact:true})).toBeVisible()
  await createVariant('DRAFT','Medium','Red','991003','11.00','3')
  page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'Remove draft DRAFT',exact:true}).click()
  await expect(page.getByRole('button',{name:'Remove draft DRAFT',exact:true})).toHaveCount(0)
  for(const width of [375,390,768,1440]){
    await page.setViewportSize({width,height:1000})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
    await page.locator('.variant-management').screenshot({path:pictures+`management-${width}.png`})
  }
  const rows=(await database.query<{id:string;sku:string;revision:string}>('select id,sku,revision::text from public.pos_products where store_id=$1 and parent_product_id is not null',[store])).rows
  const small=rows.find(row=>row.sku==='TS-S-B')!,large=rows.find(row=>row.sku==='TS-L-W')!
  assert.equal((await api(`/catalog/variants/${small.id}`,'DELETE',{store_id:store,revision:small.revision})).status(),409)
  const parent=(await database.query<{id:string;revision:string}>('select id,revision::text from public.pos_product_parents where store_id=$1',[store])).rows[0]
  await database.exec('set role authenticated')
  assert.equal((await database.query('select * from public.pos_product_parents')).rows.length,0)
  await assert.rejects(database.query('insert into public.pos_product_parents(store_id,name) values($1,$2)',[store,'Unauthorized']),/permission denied/)
  await database.exec('reset role')
  await database.query("update public.store_memberships set role='cashier' where store_id=$1 and user_id=$2",[store,owner])
  assert.equal((await api('/catalog/product-parents','POST',{store_id:store,name:'Not a manager'})).status(),403)
  await database.query("update public.store_memberships set role='owner' where store_id=$1 and user_id=$2",[store,owner])
  const otherStore=randomUUID()
  await database.query("insert into public.stores(id,name,code,created_by) values($1,'Other store','variants-other',$2)",[otherStore,owner])
  await assert.rejects(database.query("insert into public.pos_products(store_id,parent_product_id,option_values,is_draft,active,name,sku,unit_price_cents) values($1,$2,'{\"Size\":\"XL\"}',true,false,'Invalid','INVALID',100)",[otherStore,parent.id]),/foreign key/)
  assert.equal((await api('/catalog/variants','POST',{store_id:store,parent_product_id:parent.id,sku:'PLAIN',option_values:{Size:'XL'},unit_price_cents:100,active:false})).status(),409)
  assert.equal((await api(`/catalog/product-parents/${parent.id}`,'PATCH',{store_id:store,name:'Wrong revision',revision:'0'})).status(),409)
  await assert.rejects(database.query('update public.pos_products set is_draft=true,active=false where id=$1',[small.id]),/publication/)
  const feed=(await database.query<{entity_type:string;action:string;payload:{product?:{option_values:object}}}>('select entity_type,action,payload from public.pos_change_feed where store_id=$1 order by position',[store])).rows
  assert.ok(feed.some(row=>row.entity_type==='product_parent'))
  assert.ok(feed.some(row=>row.payload.product?.option_values))
  assert.ok(feed.some(row=>row.action==='delete'))
  // Real provisioning and PIN unlock, then the real terminal catalog snapshot.
  const employee=await api('/terminal-auth/employees','POST',{store_id:store,name:'Variant cashier',pin:'123456',role:'cashier',active:true})
  assert.equal(employee.status(),201)
  await page.goto('http://127.0.0.1:3188/settings/terminals')
  await page.getByLabel('Terminal name',{exact:true}).fill('Variant counter')
  await page.getByRole('button',{name:'Provision this browser',exact:true}).click()
  await expect(page.getByRole('status').filter({hasText:'This browser is provisioned'})).toBeVisible()
  await page.goto('http://127.0.0.1:3188/pos/login')
  await page.getByLabel('Select employee').selectOption({label:'Variant cashier · cashier'})
  for(const digit of '123456') await page.getByRole('button',{name:digit,exact:true}).click()
  await page.getByRole('button',{name:'Unlock POS',exact:true}).click()
  await expect(page.locator('.catalog-card').filter({hasText:'T-Shirt'})).toHaveCount(1)
  await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller))
  const complete=async()=>{
    await page.getByRole('link',{name:'Proceed to payment'}).click()
    await page.getByRole('button',{name:'Exact amount'}).click()
    await page.getByRole('button',{name:'Complete sale'}).click()
    await expect(page).toHaveURL(/\/pos\/orders\/[a-f0-9-]+$/)
    await expect(page.locator('.receipt-page .sale-receipt')).toBeVisible()
    return page.url()
  }
  await page.locator('.catalog-card').filter({hasText:'Ordinary Mug'}).click()
  await complete()
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('Ordinary Mug')
  await page.getByRole('link',{name:'New sale'}).click()
  await page.locator('.catalog-card').filter({hasText:'T-Shirt'}).click()
  await expect(page.getByRole('dialog',{name:'Choose a variant'})).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.catalog-card').filter({hasText:'T-Shirt'})).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  for(const width of [375,390,768,1440]){
    await page.setViewportSize({width,height:1000})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
    await page.screenshot({path:pictures+`picker-${width}.png`,fullPage:true})
  }
  await page.getByRole('dialog').getByRole('button').filter({hasText:'TS-S-B'}).click()
  await expect(page.locator('.sale-cart')).toContainText('Size: Small')
  const smallReceipt=await complete()
  await page.getByRole('link',{name:'New sale'}).click()
  await page.locator('#catalog-search').fill('991002')
  await page.locator('#catalog-search').press('Enter')
  await expect(page.locator('.sale-cart')).toContainText('Size: Large')
  await expect(page.locator('.sale-cart')).not.toContainText('Size: Small')
  await complete()
  // Wait for actual uploads, then verify independent central stock.
  await expect.poll(async()=> (await database.query<{n:number}>('select count(*)::int n from public.pos_orders where store_id=$1',[store])).rows[0].n).toBe(3)
  const stocks=(await database.query<{sku:string;current_stock:number}>('select p.sku,s.current_stock from public.pos_products p join public.pos_stock s on s.product_id=p.id where p.store_id=$1',[store])).rows
  assert.equal(stocks.find(row=>row.sku==='TS-S-B')?.current_stock,6)
  assert.equal(stocks.find(row=>row.sku==='TS-L-W')?.current_stock,8)
  await page.getByRole('link',{name:'New sale'}).click()
  await expect(page.locator('.catalog-card').filter({hasText:'T-Shirt'})).toBeVisible()
  await context.setOffline(true)
  await page.reload()
  await page.locator('#catalog-search').fill('991001')
  await page.locator('#catalog-search').press('Enter')
  const offlineReceipt=await complete()
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('Color: Black')
  await page.reload()
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('Size: Small')
  await context.setOffline(false)
  await expect.poll(async()=> (await database.query<{n:number}>('select count(*)::int n from public.pos_orders where store_id=$1',[store])).rows[0].n).toBe(4)
  // Editing live catalog names/options/price never changes committed receipts or lines.
  const current=(await api(`/catalog/product-parents?store_id=${store}`,'GET')).status()
  assert.equal(current,200)
  const payload=await (await api(`/catalog/product-parents?store_id=${store}`,'GET')).json() as {variants:Array<Record<string,unknown>>}
  const variant=payload.variants.find(v=>v.id===small.id)!
  assert.equal((await api(`/catalog/variants/${small.id}`,'PATCH',{...variant,store_id:store,option_values:{Size:'Small',Color:'Navy'},unit_price_cents:1800,active:false})).status(),200)
  assert.equal((await api(`/catalog/product-parents/${parent.id}`,'PATCH',{store_id:store,name:'New T-Shirt name',revision:parent.revision})).status(),200)
  await page.goto(smallReceipt)
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('Color: Black')
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('$12.00')
  await expect(page.locator('.receipt-page .sale-receipt')).not.toContainText('Navy')
  await page.screenshot({path:pictures+'historical-receipt-1440.png',fullPage:true})
  await page.getByRole('link',{name:'New sale'}).click()
  await expect(page.locator('.catalog-card').filter({hasText:'New T-Shirt name'})).toBeVisible()
  await page.locator('#catalog-search').fill('991001');await page.locator('#catalog-search').press('Enter')
  await expect(page.getByRole('alert')).toContainText('Product not found')
  await expect(page.locator('.sale-cart')).not.toContainText('Navy')
  await page.goto('http://127.0.0.1:3188/pos/orders')
  await expect(page.locator('.history-list article')).toHaveCount(4)
  await page.goto(offlineReceipt)
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('Color: Black')
  const history=(await database.query<{snapshot_name:string;snapshot_price_cents:string}>('select snapshot_name,snapshot_price_cents::text from public.pos_order_items where store_id=$1 and product_id=$2',[store,small.id])).rows
  assert.ok(history.every(row=>row.snapshot_name.includes('Color: Black') && row.snapshot_price_cents==='1200'))
  await page.goto('http://127.0.0.1:3188/dashboard')
  await expect(page.getByRole('heading',{name:'Top products today'})).toBeVisible()
  await expect(page.locator('.ranked-list')).toContainText('Color: Black')
  await expect(page.locator('.ranked-list')).toContainText('Size: Large')
  await page.screenshot({path:pictures+'variant-report-1440.png',fullPage:true})
  assert.deepEqual(errors,[])
  console.log('PASS: migrations, manager variants, draft removal, SKU conflicts, revision safety, normal checkout, each variant, HID barcode, separate stock, real terminal offline sync, inactive exclusion and immutable historical options. Chromium '+browser.version())
} finally {
  await browser?.close();webServer.closeAllConnections();identityServer.closeAllConnections()
  webServer.close();identityServer.close();await database.close();await db.end()
}
