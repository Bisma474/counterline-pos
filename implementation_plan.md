# Catalog, Local Checkout, and Order Sync — Implementation Plan
## Branch: `feat/catalog-checkout-sync`

**Base:** `develop` (HEAD: `d9596ec` — PR #1 merged)
**PR 2 reference:** `feat/offline-pos-foundation` — reviewed for reusable patterns, **not merged**.

---

## Background & Scope

The develop branch currently has:
- Auth, store creation, invitations, team management ✅
- A static/hardcoded Register screen with disabled controls ✅
- No Dexie, no API layer, no migration beyond `202609130001_auth_and_stores.sql`

This task delivers:
1. **Catalog migration + seed** — store-scoped products, categories, tax rates, stock, demo data
2. **API catalog/snapshot routes** — `GET /catalog/snapshot` so the terminal can bootstrap
3. **Local-first Dexie store** — products, categories, tax rates, orders, order items, payments, outbox, sync metadata
4. **Live Register screen** — real catalog from Dexie, search, category filter, cart, checkout
5. **MVP order push** — sync outbox records to the API; server saves order, items, payment, ledger, stock movement
6. **Order history screen** — local list with pending/synced/rejected states
7. **Outbox status update** — API response updates local outbox after accepted/rejected

---

## User Review Required

> [!IMPORTANT]
> **`apps/api/src/app.ts` will be modified** to mount two new routers (`catalogRouter`, `ordersRouter`). Per your instruction, I'm flagging this before touching it. The change is additive only — existing stub routes (`/devices/provision`, `/auth/*`, `/sync/*`) are untouched.

> [!WARNING]
> **PR 2's migration `202609140001_offline_pos_foundation.sql`** covers terminal, employee, device session, product, order, payment, operation ledger, stock, feed and snapshot tables. You said **do not merge PR 2**, and to avoid touching Ahmed's future terminal/device/employee migration.
> This plan creates **only** catalog and order-related tables in a new timestamped file. Employee, device, and session tables are left for Ahmed's migration.

> [!IMPORTANT]
> **Packages structure:** PR 2 introduced `packages/domain/` (shared money math) and `apps/api/`. On `develop` neither exists yet. This plan adds both, carrying forward the good domain math from PR 2 and the Express skeleton. The `apps/web/package.json` will get `dexie` and `zustand` added.

---

## Open Questions

> [!NOTE]
> No blocking ambiguities — all decisions are derivable from docs. Assumptions documented below per area.

- **Catalog API auth:** The catalog snapshot API uses a Bearer token (device access token per doc 03). For the MVP, since provisioning isn't built yet, I'll use a Supabase service-role key in the API env only (never browser) and protect routes with a simple device-token middleware stub that can be swapped later. *Confirm if you want a pass-through for now instead.*
- **Demo seed data:** I'll seed 6 products (same names as PR 2 reference catalog) + 3 categories + 1 tax rate at 8% in the SQL migration under a guard so it's safe to re-run. *Confirm if you want different products or tax rates.*
- **Receipt prefix:** Since real device provisioning (Ahmed's work) isn't done, for local checkout I'll use the same `LOCAL-` prefix approach from PR 2 that can be swapped once provisioning lands. *Confirm if acceptable.*
- **Order push endpoint auth:** `POST /api/orders/push` will require a `x-device-token` header. For MVP testing with no provisioning, I'll document the test token setup in `.env.example`.

---

## Proposed Changes

### 1. Shared Money Domain Package

#### [NEW] `packages/domain/src/money.ts`
Carry forward exactly from PR 2 (already correct per doc 01/05 rules). `calculateLine`, `formatCents`, bounds assertions.

#### [NEW] `packages/domain/src/money.test.ts`
Carry forward test suite from PR 2.

#### [NEW] `packages/domain/package.json` + `packages/domain/tsconfig.json`
Same as PR 2. Provides `@counterline/domain` for shared import.

---

### 2. Supabase Migration — Catalog & Order Tables

#### [NEW] `supabase/migrations/202609150001_catalog_and_orders.sql`

**Tables created (new, not overlapping Ahmed's device/employee scope):**

| Table | Notes |
|---|---|
| `pos_categories` | `id, store_id, name, parent_id nullable, active` |
| `pos_tax_rates` | `id, store_id, name, rate_bps int 0–10000, active` |
| `pos_products` | `id, store_id, sku (unique/store), barcode (indexed), name, category_id, tax_rate_id, unit_price_cents BIGINT, active, revision BIGINT` |
| `pos_stock` | `store_id + product_id PK, current_stock int (negative allowed), updated_at` |
| `pos_orders` | Full schema per doc 04; store_id, installation_id (nullable for MVP), employee_id (nullable for MVP), receipt_number, subtotal/tax/total_cents BIGINT, catalog_version, client_generated_at, server_received_at, schema_version=1 |
| `pos_order_items` | order_id, product_id, snapshots (name, sku, price, tax), quantity, line amounts BIGINT |
| `pos_payments` | Independent UUID, order_id unique, method, amount/tendered/change_cents BIGINT, cash/card constraint |
| `pos_operation_ledger` | `store_id + operation_id PK`, payload_hash, result_json, accepted_checkpoint, status enum, processed_at |
| `pos_inventory_movements` | `store_id + operation_id + product_id PK`, delta nonzero, reason sale/opening_stock |
| `pos_sync_feed_state` | `store_id PK`, last_position BIGINT — locked before publishing |
| `pos_change_feed` | `store_id + position PK`, entity_type, entity_id, action, version, payload JSONB |

**Indexes:**
- `pos_products(store_id, active)` — catalog listing
- `pos_products(store_id, sku)` — SKU lookup
- `pos_products(store_id, barcode) WHERE barcode IS NOT NULL` — barcode scan
- `pos_products(store_id, name)` — name search (gin tsvector or ILIKE index)
- `pos_orders(store_id, client_generated_at DESC)` — order history
- `pos_change_feed(store_id, position)` — sync pull

**RLS:** Enabled on all tables. Store-scoped read/write policies via `is_store_member()` helper (already exists from migration 001). Express API uses service-role key (server-side only).

**Demo seed data (guarded with `ON CONFLICT DO NOTHING`):**
- 1 store assumed present (seed binds to `SELECT id FROM stores LIMIT 1`)
- 3 categories: Home, Apparel, Food & Drink
- 1 tax rate: Standard 8% (800 bps)
- 6 products (Ceramic Mug, Canvas Tote, Scented Candle, Hand Soap, Olive Oil, Tea Blend) with realistic prices in cents and opening stock via `pos_inventory_movements` + `pos_stock` upsert

---

### 3. Express API App

#### [MODIFY] `apps/api/src/app.ts`
**Additive only.** Mount two new routers before existing stubs:
```ts
import { catalogRouter } from './routes/catalog'
import { ordersRouter } from './routes/orders'
// ...
app.use('/catalog', catalogRouter)
app.use('/orders', ordersRouter)
// existing stubs remain untouched below
```

#### [NEW] `apps/api/src/routes/catalog.ts`
- `GET /catalog/snapshot?store_id=<uuid>` — returns categories, tax_rates, products, stock as a single JSON snapshot page. Uses service-role pg client. Requires `Authorization: Bearer <device-token>` middleware (MVP stub validates a configured env token).
- Returns `{ snapshotId, checkpoint, catalog_version, categories[], tax_rates[], products[], stock{} }`

#### [NEW] `apps/api/src/routes/orders.ts`
- `POST /orders/push` — accepts `{ operations: OrderOperation[] }`. For each operation:
  1. Check idempotency in `pos_operation_ledger`
  2. Validate totals using shared domain logic
  3. In one pg transaction: insert order → items → payment → ledger row (accepted) → grouped stock movements → `pos_stock` upsert → change_feed entry (locked via `pos_sync_feed_state`)
  4. Return `{ results: [{ operationId, outcome: 'accepted' | 'rejected', reason?, acceptedCheckpoint }] }`
  5. Rejected on validation error: sets ledger status = rejected, returns reason

#### [NEW] `apps/api/src/middleware/device-auth.ts`
MVP: validates `Authorization: Bearer $DEVICE_TOKEN` against env var. Placeholder for real device session JWT later.

#### [NEW] `apps/api/src/db.ts`
`pg.Pool` singleton initialized from `DATABASE_URL` env var.

#### [MODIFY] `apps/api/package.json`
Add: `pg`, `@types/pg`, `cors`, `dotenv`, `zod` (already there), remove nothing.

---

### 4. Dexie Local Database (Web)

#### [NEW] `apps/web/src/lib/db.ts`
Full Dexie v4 schema with versioned upgrade path:

**Object stores:**
- `store_config` — `store_id`, name, timezone, currency, catalog_version
- `categories` — `id`, store_id, name, active
- `tax_rates` — `id`, store_id, name, rate_bps, active
- `products` — `id, &sku, barcode, category_id, active` — server-owned cache
- `server_stock` — `product_id`, current_stock, updated_at
- `orders` — `id, &receipt_number, client_generated_at, sync_status`
- `order_items` — `id, order_id, product_id`
- `payments` — `id, &order_id`
- `outbox` — `++id, &operation_id, status, next_attempt_at`
- `sync_metadata` — `key` (last_pull_checkpoint, last_receipt_seq, catalog_version)

Carry forward and extend PR 2's `CounterlineDatabase` class. Add missing stores per doc 04.

#### [NEW] `apps/web/src/lib/catalog.ts`
- `loadCatalogSnapshot(storeId)` — fetches from `GET /catalog/snapshot`, writes categories/tax_rates/products/stock atomically to Dexie, saves catalog_version and checkpoint in sync_metadata
- `searchProducts(query)` — queries Dexie products by name (case-insensitive contains), sku (exact), or barcode (exact); returns active products only
- `getProductsByCategory(categoryId)` — filters Dexie

#### [NEW] `apps/web/src/lib/checkout.ts`
`commitLocalSale(lines, paymentMethod, tenderedCents)` — carries forward PR 2's atomic transaction pattern, **extended** to:
- Write `orders`, `order_items`, `payments`, `outbox`, and increment `sync_metadata.last_receipt_seq` — all in one Dexie transaction
- Validate totals using `@counterline/domain` `calculateLine`
- Return `{ orderId, receiptNumber, changeCents, totals }`

#### [NEW] `apps/web/src/lib/sync.ts`
`pushPendingOrders()` — MVP push flow:
1. Query outbox for `status = 'pending'`
2. POST to `/orders/push` with operation payloads
3. For each result:
   - `accepted`: update outbox `status = 'synced'`, update order `sync_status = 'synced'`
   - `rejected`: update outbox `status = 'failed'`, store reason
4. All updates atomic per operation result

---

### 5. Web App — Register Screen

#### [MODIFY] `apps/web/src/App.tsx`
**Minimal, additive change only:**
- Import `RegisterScreen` from new file and use it in the `/register` route
- Import `OrderHistoryScreen` from new file and use it in the `/orders` route
- All other routes/screens unchanged

#### [NEW] `apps/web/src/screens/RegisterScreen.tsx`
Full interactive POS register, replacing the placeholder `Register()` function in App.tsx:

**Catalog panel (left):**
- Search input: queries Dexie by name / SKU / barcode on keystroke (debounced 150ms)
- Category filter buttons: All + store categories from Dexie
- Product grid: cards with name, formatted price, stock badge; clicking adds to cart

**Cart panel (right / drawer on mobile):**
- Line items: product name, unit price, quantity +/– controls, line total
- Clear cart button
- Subtotal, Tax, Total display (all formatted from integer cents)
- "Proceed to payment" button

**Empty/loading/error states** properly displayed.

**Bootstrap:** On mount, checks Dexie for products. If none, calls `loadCatalogSnapshot()` automatically.

#### [NEW] `apps/web/src/screens/PaymentScreen.tsx`
Replaces the placeholder `Payment()` function:
- Shows cart summary with line items and totals from Zustand store
- Cash / External Card method selection
- Cash: tendered amount input (validates ≥ total), change display
- Card: external reference optional input, "Confirm payment approved" toggle
- "Complete sale" calls `commitLocalSale()`, shows success with receipt number and change
- On success: clears cart, shows receipt overlay with print action
- Immediately calls `pushPendingOrders()` in background after commit

#### [MODIFY] `apps/web/src/lib/pos-store.ts`
Carry forward PR 2's Zustand cart store (`usePosStore`) onto the develop branch. Extend to include `syncStatus`.

---

### 6. Order History Screen

#### [NEW] `apps/web/src/screens/OrderHistoryScreen.tsx`
Replaces the `Placeholder` on `/orders`:
- Lists local orders from Dexie ordered by `client_generated_at DESC`
- Each row: receipt number, date/time, total, payment method, sync badge (`Pending`, `Synced`, `Rejected`)
- Rejected row shows failure reason inline
- "Retry" action on failed outbox rows triggers `pushPendingOrders()`
- Responsive: stacked card list on mobile, table on desktop

---

### 7. Dependencies to Add

#### [MODIFY] `apps/web/package.json`
```json
"dexie": "^4.0.9",
"zustand": "^5.0.3"
```

#### [MODIFY] `apps/api/package.json`
```json
"pg": "^8.13.3",
"@types/pg": "^8.11.10",
"cors": "^2.8.5",
"dotenv": "^16.4.7"
```

---

## Verification Plan

### Build Check
```powershell
cd apps/web
npm install
npm run build
```
Must complete with zero TypeScript errors.

### Migration Safety Check
Confirm new migration file timestamp `202609150001` is after `202609130001` (auth_and_stores) and before any future Ahmed migration (`202609160001` or later). No tables overlap. Existing migration untouched.

### Manual Verification
1. Apply migration to local Supabase: `supabase db reset` or `supabase migration up`
2. Start API: `cd apps/api && npm run dev`
3. Start web: `cd apps/web && npm run dev`
4. Open Register — should auto-load catalog from API into Dexie on first boot
5. Search "mug" — Ceramic Mug appears
6. Filter by "Home" category — shows home products only
7. Add items to cart, adjust quantities, clear cart
8. Proceed to payment → cash flow → enter amount ≥ total → Complete sale
9. Receipt number shown, change displayed
10. Check /orders screen — order shows as Pending
11. Trigger push — order moves to Synced
12. Check database: `pos_orders`, `pos_order_items`, `pos_payments`, `pos_operation_ledger`, `pos_inventory_movements` all populated

### Regression Check
- `/login`, `/signup`, `/reset-password`, `/invite`, `/settings` screens unchanged and functional
- Mobile layout at 375px: catalog grid, cart drawer, order list

---

## File Change Summary

| File | Status | Notes |
|---|---|---|
| `supabase/migrations/202609150001_catalog_and_orders.sql` | NEW | Catalog + order tables, indexes, RLS, seed |
| `packages/domain/src/money.ts` | NEW | Carried from PR 2 verbatim |
| `packages/domain/src/money.test.ts` | NEW | Carried from PR 2 verbatim |
| `packages/domain/package.json` | NEW | Shared domain package |
| `packages/domain/tsconfig.json` | NEW | TS config for domain |
| `apps/api/src/db.ts` | NEW | pg pool singleton |
| `apps/api/src/middleware/device-auth.ts` | NEW | MVP Bearer token check |
| `apps/api/src/routes/catalog.ts` | NEW | GET /catalog/snapshot |
| `apps/api/src/routes/orders.ts` | NEW | POST /orders/push |
| `apps/api/src/app.ts` | MODIFY | Mount 2 new routers (additive) |
| `apps/api/package.json` | MODIFY | Add pg, cors, dotenv |
| `apps/web/src/lib/db.ts` | NEW | Dexie schema (extends PR 2) |
| `apps/web/src/lib/catalog.ts` | NEW | Snapshot loader + search helpers |
| `apps/web/src/lib/checkout.ts` | NEW | Atomic commitLocalSale |
| `apps/web/src/lib/sync.ts` | NEW | pushPendingOrders MVP |
| `apps/web/src/lib/pos-store.ts` | NEW | Zustand cart store (from PR 2) |
| `apps/web/src/screens/RegisterScreen.tsx` | NEW | Full interactive register |
| `apps/web/src/screens/PaymentScreen.tsx` | NEW | Payment + checkout commit |
| `apps/web/src/screens/OrderHistoryScreen.tsx` | NEW | Local order history |
| `apps/web/src/App.tsx` | MODIFY | Wire new screens into routes |
| `apps/web/package.json` | MODIFY | Add dexie, zustand |
| `apps/web/.env.example` | MODIFY | Add VITE_API_URL |
| `apps/api/.env.example` | NEW | DATABASE_URL, DEVICE_TOKEN, CORS_ORIGIN |

**Do NOT touch:**
- `supabase/migrations/202609130001_auth_and_stores.sql`
- Any login/signup/reset/invite/settings component
- `apps/web/src/styles.css` (visual system unchanged)
- Any file not in the table above

---

## PR Description (to be submitted)

**Branch:** `feat/catalog-checkout-sync` → `develop`

**What changed:**
- New migration `202609150001_catalog_and_orders.sql` adds catalog, order, payment, ledger, stock, and feed tables with RLS, indexes, and demo seed data
- Shared `@counterline/domain` package with integer-cents math (from PR 2, carried forward cleanly)
- Express API with `GET /catalog/snapshot` and `POST /orders/push` routes
- Dexie local database replacing all hardcoded catalog references
- Interactive Register screen with real product search, category filter, cart controls
- Payment screen with local-first atomic checkout
- Order history screen with pending/synced/rejected states
- Background sync that pushes completed orders to the API

**Testing:** Build passes, all scenarios listed in Verification Plan above.

**Limitations:**
- Device provisioning and employee PIN login (Ahmed's scope) are not yet wired — receipt prefix uses LOCAL- prefix placeholder
- Pull sync (change feed) is not implemented in this PR — that is the next task
- Manager discount approval is not yet implemented
