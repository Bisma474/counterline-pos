import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Import the route module after setting a harmless pool URL; pure validation tests never open a
// connection, and the PGlite-backed tests below monkey-patch db.query/db.connect before use.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { storeIdParam, dateParam, loadDailySummary, loadOrdersPage } = await import('./reports.js')
const { db } = await import('../db.js')

function reqWith(query: Record<string, unknown>) {
  return { query } as unknown as Parameters<typeof storeIdParam>[0]
}

test('storeIdParam and dateParam reject malformed input', () => {
  assert.throws(() => storeIdParam(reqWith({ store_id: 'not-a-uuid' })), /valid store_id/)
  assert.throws(() => storeIdParam(reqWith({})), /valid store_id/)
  assert.throws(() => dateParam(reqWith({ date: '2026-13-40' })), /valid date/)
  assert.throws(() => dateParam(reqWith({ date: 'not-a-date' })), /valid date/)
  assert.doesNotThrow(() => dateParam(reqWith({ date: '2026-09-18' })))
})

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const chain = [
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
]

test('loadDailySummary aggregates orders, items and payments within the store timezone day', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
    for (const name of chain) {
      const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
      await database.exec(sql)
    }
    const owner = randomUUID(), store = randomUUID(), product = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    // UTC+5 store timezone: a sale at 2026-09-18T20:00:00Z is 2026-09-19 01:00 local — the next
    // calendar day in the store's own timezone, so it must not appear in the 09-18 summary.
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','daily-summary',$2,'Asia/Karachi')", [store, owner])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-1','Test item',500)`, [product, store])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }

    const insertOrder = async (receipt: string, generatedAtUtc: string) => {
      const id = randomUUID()
      await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at)
        values ($1,$2,$3,'USD','One','Asia/Karachi',500,0,25,525,1,$4)`, [id, store, receipt, generatedAtUtc])
      await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
        snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
        values ($1,$2,$3,$4,'Test item','SKU-1',500,500,1,2,500,0,500,25,525)`, [randomUUID(), store, id, product])
      await database.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,client_generated_at)
        values ($1,$2,$3,'cash',525,525,0,$4)`, [randomUUID(), store, id, generatedAtUtc])
    }
    await insertOrder('DS-000001', '2026-09-18T10:00:00.000Z') // 15:00 local on the 18th
    await insertOrder('DS-000002', '2026-09-18T20:00:00.000Z') // 01:00 local on the 19th — excluded

    const summary = await loadDailySummary(store, '2026-09-18')
    assert.equal(summary.completedOrderCount, 1)
    assert.equal(summary.grossSalesCents, 500)
    assert.equal(summary.taxCents, 25)
    assert.equal(summary.recordedTotalCents, 525)
    assert.equal(summary.cashTakingsCents, 525)
    assert.equal(summary.cardTakingsCents, 0)
    assert.equal(summary.itemsSold, 2)
    assert.equal(summary.averageSaleCents, 525)

    const nextDay = await loadDailySummary(store, '2026-09-19')
    assert.equal(nextDay.completedOrderCount, 1)
    assert.equal(nextDay.recordedTotalCents, 525)
  } finally { await database.close() }
})

test('loadOrdersPage paginates by cursor and joins the cashier name', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
    for (const name of chain) {
      const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
      await database.exec(sql)
    }
    const owner = randomUUID(), store = randomUUID(), product = randomUUID(), employee = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','orders-page',$2,'UTC')", [store, owner])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-1','Test item',500)`, [product, store])
    await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,'Casey','cashier',$3,$4)`,
      [employee, store, '1'.repeat(32), '2'.repeat(64)])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }

    const orderIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const id = randomUUID()
      orderIds.push(id)
      await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,employee_id)
        values ($1,$2,$3,'USD','One','UTC',500,0,0,500,1,'2026-09-18T10:00:00.000Z',$4)`,
        [id, store, `OP-00000${i + 1}`, i === 0 ? employee : null])
      await database.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,client_generated_at)
        values ($1,$2,$3,'card',500,500,0,'2026-09-18T10:00:00.000Z')`, [randomUUID(), store, id])
    }
    orderIds.sort()

    const first = await loadOrdersPage(store, '2026-09-18', null, 2)
    assert.equal(first.orders.length, 2)
    assert.ok(first.next_cursor)
    assert.equal(first.orders.map(o => o.id).join(','), orderIds.slice(0, 2).join(','))

    const second = await loadOrdersPage(store, '2026-09-18', JSON.parse(Buffer.from(first.next_cursor!, 'base64url').toString()).id, 2)
    assert.equal(second.orders.length, 1)
    assert.equal(second.next_cursor, null)
    assert.equal(second.orders[0].id, orderIds[2])

    const attributed = first.orders.find(o => o.id === orderIds[0])!
    assert.equal(attributed.employeeId, employee)
    assert.equal(attributed.cashierName, 'Casey')
    assert.equal(attributed.paymentMethod, 'card')
    assert.equal(attributed.itemCount, 0)
  } finally { await database.close() }
})
