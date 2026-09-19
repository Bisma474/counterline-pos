# Counterline POS — QA / Architecture Report

Generated 2026-09-19, updated 2026-09-19 on branch `fix/qa-report-findings` (off `develop`, not yet committed/pushed). Scope: repo + live DB reached via `apps/api/.env`/`.env.local` `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. This update ran real DDL (one additive migration, applied and verified) and created one real test user + store, in addition to further read-only queries. Secrets are never printed below.

## 0. Changes made in this follow-up pass

All work is uncommitted on `fix/qa-report-findings`, pending review.

1. **P1 fixed & verified live**: added `supabase/migrations/202609200001_service_role_only_rls_policies.sql` (explicit deny-all policies for `anon`/`authenticated` on the 8 previously-zero-policy tables) and applied it to the live DB via `apps/api/scripts/apply-migration.mjs`; confirmed all 8 policies exist with a live `pg_policies` query. Added `apps/web/tests/service-role-only-tables.test.ts`, a grep-based guard test that fails the build if `apps/web/src` ever calls `.from()` on any of those 8 table names (currently zero, confirmed).
2. **P2 fixed & tested**: `apps/web/src/lib/order-sync-core.ts`'s `finish()` now deletes an order's `stock_adjustments` rows when its outbox entry permanently fails validation, instead of leaving a phantom stock deduction that checkpoint-based cleanup could never reach (it required a truthy `accepted_checkpoint`, which a rejected sale never gets). Added a new unit test (`apps/web/tests/checkout.test.ts`) proving the rollback; updated one pre-existing test whose assertion described the old (buggy) behavior. All 21 tests in `apps/web`'s suite pass (`npm test` in `apps/web`).
3. **P2 fixed**: added `supabase/migrations/APPLIED.md`, a ledger of all 15 migration files (14 original + the new one), each cross-checked against the live schema via `apps/api/scripts/verify-migrations.mjs` (queries `information_schema`/`pg_catalog` for an object each migration creates, or confirms absence for a `drop`). All 15 confirmed applied; no drift found.
4. **P3 traced**: reports (`apps/api/src/routes/reports.ts`) confirmed **BACKED** — real server-side aggregation over live `pos_orders`, role-gated to owner/manager, with 5 passing integration tests that hit the real DB (`npx tsx --test src/routes/reports.test.ts` in `apps/api`). Refunds confirmed **not present on this branch** — `pos_refunds`/`pos_refund_items` exist live with 3 rows each only because this Supabase project is shared across branches; the actual refund feature (`POST /orders/:id/refund`, owner/manager-gated, tested) lives on unmerged branch `feat/store-settings-and-catalog-extensions` (commit `1e3aeef`), 9 commits ahead of `develop` for that work. Cashier "shift" sessions (`terminal_cashier_sessions`) confirmed **BACKED** as short-lived (15 min) PIN-login auth tokens — there is no separate cash-drawer/till-count feature in this codebase at all (a real feature gap, not a bug). Roles/memberships confirmed **BACKED** — used for gating across `apps/api/src/routes/{reports,catalog,customers,audit,auth}.ts` and `terminal-auth/routes.ts`.
5. **Phase 5 (E2E) actually run**, not just attempted. `apps/api` already had 4 real Playwright browser-check fixtures (`test/*-browser-check.ts`) that build the real web app, drive an actual Chromium browser against it, and assert against a real Postgres (in-memory PGlite with the real migration files replayed) or the real live DB — but none had ever been executed; they had rotted against newer UI/schema changes. Fixed and ran 3 of 4:
   - `catalog-browser-check.ts`: **PASSES.** Fixed a stale fixture (didn't mock `/rest/v1/stores`, which `App.tsx`'s onboarding-status check now queries). Real proof: browse/search/filter catalog, add a product through the UI, and confirm it committed to `pos_products` + `pos_stock` + `pos_change_feed` — then confirm it's immediately sellable at `/register` with no manual refresh. Responsive at 375/390/768/1440 confirmed.
   - `customer-browser-check.ts`: **PASSES**, after 3 real fixes (not just fixture patching — this test replays only 5 of 15 migrations, so it also caught real schema drift): (a) same `/rest/v1/stores` mock gap; (b) missing 10 migrations including `cart_discounts.sql`, whose absence caused a live `42703 column does not exist` error from the dashboard's own report query — added the full 15-migration replay; (c) the test assumed new stores still auto-seed a demo catalog, which `202609190002_remove_demo_catalog_seed.sql` deliberately removed — added explicit product seeding to match the new owner-must-add-products reality. **This is the closest thing to the report's "killer test": it proves a cashier can create a customer and complete a cash sale fully offline, that both survive a page reload while still offline (confirmed zero rows server-side), and that on reconnect the customer uploads before the order (respecting the dependency), landing exactly 1 row each in `pos_customers` and `pos_orders`.** It also surfaced a real, previously-undocumented gap: fixing it required navigating off the Receipt screen after reconnecting, because **the Receipt screen and `CashierPosLayout` have no sync trigger of their own** — only `RegisterScreen` and `OrderHistoryScreen` listen for `online`/poll every 15s. A cashier who completes a sale (landing on Receipt, per the current receipt-first UX) and stays there while reconnecting will not see it sync until they navigate to Sell or Orders. Logged as a new P2 finding below.
   - `reporting-browser-check.ts`: **still failing, left as-is per explicit instruction to stop this pass.** Fixed the same `/rest/v1/stores` gap and got substantially further (real Dexie-aggregated daily report renders with correct numbers — Gross $40.00, Tax $3.40, Recorded total $43.40/3 orders, Pending 1/$15.90, Rejected 1/$5.50 — all real local math, not decorative), but it fails later expecting a full-page "Reporting unavailable" state; instead the page partially renders with a broken "Sales by cashier" panel because the fixture never mocks the `/api/reports/...` server endpoint (gets the SPA's `index.html` back and fails to parse it as JSON). Needs an API mock or an `/api` reverse-proxy to the fixture's own PGlite, same pattern as `catalog-browser-check.ts` uses. **Left UNVERIFIED/blocked, not faked.**
   - `browser-check.ts` (terminal auth lifecycle): **not attempted this pass** (stopped per instruction before reaching it). Uses the same real-migrations-against-PGlite + real-Playwright pattern; likely has the same class of staleness as the other three. **UNVERIFIED.**
6. Created a real Supabase Auth test user (`bismamunir474+qatest@gmail.com`, auto-confirmed via the Admin API) plus a real `stores`/`store_memberships` row (owner role), for future E2E work needing an actual live-project login rather than a fixture identity server. Credentials are in `apps/api/.env.local` (gitignored), not reproduced here. **Not yet used** by any test in this pass — the 3 E2E runs above all used the existing fixture-identity-server pattern instead, which needed no real account.

Net effect: 2 of the original report's 4 UNVERIFIED "Phase 5" scenarios now have real, executed, passing browser-driven proof instead of static trace; the other 2 are honestly still open with a specific, actionable reason each.

## 1. Verdict

**Yes, with two remaining open items before full confidence at scale (both now scoped, neither a fake-persistence risk).**

- The offline core (Dexie outbox, idempotent `operation_id`, integer-cents money, checkpoint-based catalog sync, lease-based claim/retry) is a genuinely solid, non-trivial design — this is not a toy fake-offline app. This is no longer just a read of the code: a real Playwright browser, driving the real built app, proved a cashier sale + new customer created fully offline survives a reload and correctly syncs (customer before order) on reconnect.
- Live DB has real, non-trivial row counts across orders/payments/products/customers/audit tables, confirming most core flows are actually backed by Supabase, not local-only illusions. Catalog writes (add product → `pos_products`/`pos_stock`/`pos_change_feed` → instantly sellable) are now proven by a passing E2E test, not just row counts.
- The RLS zero-policy gap is fixed and verified live; the migration-ledger gap is fixed with a checked ledger file; the stock-rollback bug is fixed and unit-tested. What remains open: the reporting E2E fixture and the terminal-auth E2E fixture are still stale and unverified (§6), and a newly-found real gap — the Receipt screen never auto-triggers sync — needs a product fix (§7, new P2).

## 2. Critical: local-only / partial features (headline)

| Feature | Verdict | Why |
|---|---|---|
| Reporting/analytics screens (`apps/api/src/routes/reports.ts`) | **BACKED, confirmed live** | Real server-side SQL aggregation directly over `pos_orders`/`pos_payments`, role-gated to owner/manager (`requireReportAccess`). 5 integration tests pass against the real DB (`npx tsx --test src/routes/reports.test.ts`). The E2E browser proof of the *client* dashboard rendering these numbers is still blocked (see §6) — but the server-side data path itself is now confirmed, not just plausible. |
| Stock adjustments (`stock_adjustments` Dexie table) | **FIXED, tested** | Previously: applied optimistically locally and only reconciled against `accepted_checkpoint` on next catalog pull, which a permanently-`validation`-failed sale's delta could never reach (it never gets an `accepted_checkpoint`) — phantom stock forever. Now `order-sync-core.ts`'s `finish()` explicitly deletes the stock delta the moment a sale is permanently rejected. Proven by a new unit test. |
| Receipt screen has no sync trigger (new finding) | **PARTIAL — real gap, not fixed this pass** | `apps/web/src/receipts/ReceiptScreen.tsx` and `terminal-auth/CashierPosLayout.tsx` have no `online`-listener or polling sync call — only `RegisterScreen.tsx:76-77` and `OrderHistoryScreen.tsx:44-46` do. Since completing a sale now navigates straight to Receipt (receipt-first UX), a cashier who stays there while reconnecting will not see their sale sync until they navigate to Sell or Orders. Discovered by fixing and running `customer-browser-check.ts` for real — the test only passed once it was changed to navigate to Orders after reconnecting. See new P2 in §7. |
| Sync Center screen (`SyncCenterScreen.tsx`) | UNVERIFIED | Not reached by any E2E run this pass; still needs a live check that its "synced" badge reflects true `pos_change_feed`/DB state and not just local outbox status. |
| Refunds (`pos_refunds`/`pos_refund_items`) | **Not present on `develop`** | The 3 live rows exist only because this Supabase project is shared across branches. The actual feature (owner/manager whole-order refund, `POST /orders/:id/refund`) is real and tested but lives on unmerged branch `feat/store-settings-and-catalog-extensions` — not a bug on `develop`, just not merged yet. See §0 item 4. |

No feature was found to be **purely** decorative (writing only to Dexie with no outbox/API path) in any file reviewed — `checkout.ts`, `customers.ts`, `catalog.ts` all route through the outbox → `/orders/push` or `/customers/push` → Supabase, and this is now proven end-to-end by executed Playwright tests for the catalog and offline-customer-and-sale flows, not just static trace.

## 3. Database truth (live, read-only queries against `DATABASE_URL`)

### 3.1 Migration ledger — FIXED

`supabase_migrations.schema_migrations` still does not exist (this project doesn't use the Supabase CLI's own tracking), but that gap is now closed differently: **`supabase/migrations/APPLIED.md`** is a real, checked ledger — each of the 15 migration files (14 original + this pass's new one) has its SHA-256 recorded alongside a specific live-schema object that was queried and confirmed to exist (or, for a `drop`, confirmed absent) via `apps/api/scripts/verify-migrations.mjs`. All 15 are confirmed applied; no drift, no orphan file, no orphan live object found. Re-run that script any time to re-confirm the table stays accurate; add a row to `APPLIED.md` whenever a new migration file is added.

Migration files present (15, `supabase/migrations/`, see `APPLIED.md` for full detail):
```
202609130001_auth_and_stores.sql
202609150001_catalog_checkout_sync.sql
202609150001_terminal_employee_access.sql
202609150002_terminal_device_sessions.sql
202609150003_team_profile_visibility.sql
202609160001_customers_and_sale_attachment.sql
202609170001_change_feed_product_entity.sql
202609170002_cart_discounts.sql
202609180001_terminal_name_uniqueness.sql
202609180002_pos_orders_report_read_access.sql
202609190001_audit_log.sql
202609190001_store_onboarding_status.sql
202609190002_remove_demo_catalog_seed.sql
202609190003_store_sync_feed_init.sql
202609200001_service_role_only_rls_policies.sql (new, this pass — see §3.2)
```
All 22 live tables map to concepts present across these files (stores/profiles/memberships, pos_* catalog/order tables, terminal_* device/employee tables, audit_log, pos_change_feed/pos_sync_feed_state). No orphan/dead tables were found that aren't explained by a migration name.

### 3.2 Live tables, row counts, RLS

| Table | Rows | RLS enabled | Policy count |
|---|---:|---|---:|
| audit_log | 6 | yes | 1 |
| pos_categories | 37 | yes | 1 |
| pos_change_feed | 101 | yes | **0** |
| pos_customers | 13 | yes | 1 |
| pos_inventory_movements | 140 | yes | **0** |
| pos_operation_ledger | 43 | yes | **0** |
| pos_order_items | 42 | yes | 1 |
| pos_orders | 30 | yes | 1 |
| pos_payments | 30 | yes | 1 |
| pos_products | 97 | yes | 1 |
| pos_refund_items | 3 | yes | 1 |
| pos_refunds | 3 | yes | 1 |
| pos_stock | 97 | yes | 1 |
| pos_sync_feed_state | 13 | yes | **0** |
| pos_tax_rates | 12 | yes | 1 |
| profiles | 19 | yes | 3 |
| store_invites | 2 | yes | 1 |
| store_memberships | 14 | yes | 1 |
| stores | 13 | yes | 1 |
| terminal_cashier_sessions | 30 | yes | 1 (was 0) |
| terminal_device_sessions | 297 | yes | 1 (was 0) |
| terminal_devices | 17 | yes | 1 (was 0) |
| terminal_employees | 12 | yes | 1 (was 0) |

**Finding (P1) — FIXED, verified live.** 8 tables (`pos_change_feed`, `pos_inventory_movements`, `pos_operation_ledger`, `pos_sync_feed_state`, `terminal_cashier_sessions`, `terminal_device_sessions`, `terminal_devices`, `terminal_employees`) had RLS **on** with **no policies**, meaning Postgres denied all access to the `anon`/`authenticated` roles by default with no explicit statement of intent. Confirmed via code grep that no `apps/web/src` code calls `.from()` on any of them (also enforced now by a new guard test, `apps/web/tests/service-role-only-tables.test.ts`) — these are backend-orchestrated, service-role-only by design. Migration `202609200001_service_role_only_rls_policies.sql` adds an explicit `using (false)` deny-all policy to each, applied to the live DB and confirmed present via a live `pg_policies` query. This makes the intent explicit and machine-checkable instead of indistinguishable from an oversight, with no functional behavior change (the service-role connection `apps/api` uses already bypassed RLS).

Non-empty row counts (`pos_orders`=30, `pos_payments`=30, `pos_products`=97, `pos_customers`=13, `terminal_device_sessions`=297) are strong evidence that checkout, catalog, customers, and terminal/device auth flows are **actually exercised against the real DB** — not merely frontend-only demo data. `pos_refunds`/`pos_refund_items` at 3 rows shows returns have been exercised at least minimally.

### 3.3 Money handling
Grepped `information_schema.columns` for all price/amount/cents/total columns: every monetary column in the schema is `bigint` (integer cents) — `pos_orders.subtotal_cents/tax_cents/total_cents/discount_cents`, `pos_order_items.*_cents`, `pos_payments.amount_cents/tendered_cents/change_cents`, `pos_products.unit_price_cents`, `pos_refunds.amount_cents`. No `numeric`/`float`/`double precision` money columns found. Client-side Dexie types (`apps/web/src/lib/db.ts`) mirror this exactly with explicit `// integer cents` comments on every field. **This is correct practice and a positive finding**, not a defect.

## 4. Feature → backend traceability (static trace, not live-execution-confirmed)

| Feature | Write path | Read path | Table(s) | Local-only? | Evidence | Verdict |
|---|---|---|---|---|---|---|
| Checkout / sale | `checkout.ts` → Dexie `orders`/`order_items`/`payments`/`outbox` → `order-sync.ts:sendOrder` → API `/orders/push` or `/pos/orders/push` → server → `pos_orders` etc. | `OrderHistoryScreen.tsx`, `SyncCenterScreen.tsx` via Dexie + sync status | pos_orders, pos_order_items, pos_payments, pos_operation_ledger (idempotency) | No | `apps/web/src/lib/checkout.ts`, `apps/web/src/lib/order-sync-core.ts:1-170`, `apps/web/src/lib/order-sync.ts:1-21` | BACKED (30 live rows) |
| Catalog hydration (fresh device) | n/a (read-only) | `catalog.ts:loadCatalog` → GET `/catalog/snapshot` → replaces Dexie `products`/`categories`/`tax_rates`/`server_stock` | pos_products, pos_categories, pos_tax_rates, pos_stock | No | `apps/web/src/lib/catalog.ts:44-92` | BACKED (97 products/97 stock rows live) |
| Customers | `customers.ts`/`customer-local.ts` → outbox (`entity_type: 'customer'`) → `/customers/push` | `CustomerScreen.tsx` via Dexie + `store_memberships` check | pos_customers | No | `apps/web/src/lib/order-sync-core.ts` (customer branch throughout), `apps/web/src/screens/CustomerScreen.tsx:123` | BACKED (13 live rows) |
| Onboarding / store creation | `App.tsx:finishStoreSetup` → RPC `create_store`, `accept_store_invites` | `OnboardingWizard.tsx` reads `stores`/`store_memberships` | stores, store_memberships | No | `apps/web/src/App.tsx:57-90` | BACKED (13 stores, 14 memberships live) |
| Terminal/cashier auth (PIN login → 15-min session token) | `terminal-auth/routes.ts` → `terminal_cashier_sessions` insert on login, `expires_at=now()` update on logout/re-login | `CashierLogin.tsx`, `TerminalStatus.tsx`; session validated per-request via join on `terminal_device_sessions`+`terminal_cashier_sessions`+`terminal_employees` | terminal_devices, terminal_employees, terminal_device_sessions, terminal_cashier_sessions | No — service-role/API only by design | `apps/api/src/terminal-auth/routes.ts:42-47,171-256` | **BACKED**, RLS gap now fixed (§3.2) |
| Stock adjustments | Optimistic local delta in `stock_adjustments`, reconciled on next `loadCatalog` against `accepted_checkpoint`, **now also explicitly reversed the instant an order's outbox entry permanently fails validation** | `catalog.ts:100-108`, `order-sync-core.ts` `finish()` | pos_stock, pos_inventory_movements | No — fixed | `apps/web/src/lib/order-sync-core.ts` (`finish()`, the `else if (failureKind === 'validation')` branch), test in `apps/web/tests/checkout.test.ts` | **FIXED, tested** (was PARTIAL) |
| Reports/analytics | `apps/api/src/routes/reports.ts` — real SQL aggregation directly over live `pos_orders`/`pos_payments`, role-gated (owner/manager) | `ReportingScreens.tsx` via `server-reports.ts` → API `/reports`; local Dexie-based `reporting.ts` for register-local same-device numbers | pos_orders, pos_payments | No | `apps/api/src/routes/reports.ts:10-13` (`requireReportAccess`), 5 passing integration tests (`reports.test.ts`, hits real DB) | **BACKED, confirmed via passing integration tests against the live DB.** Client-side E2E render of these numbers is still blocked (§6) — `reporting-browser-check.ts` gets real correct numbers on screen from local Dexie math but fails later on an unmocked `/api/reports` call in that fixture. |
| Returns/refunds | `POST /orders/:id/refund` (owner/manager-gated), real transaction inserting refund + line items, reversing stock via a `refund` inventory-movement reason, writing change-feed entries, rejecting a second refund with 409 | "Refund this receipt" on owner/manager Receipt screen | pos_refunds, pos_refund_items, pos_inventory_movements | No, where present | Commit `1e3aeef` on branch `feat/store-settings-and-catalog-extensions` (9 commits ahead of `develop` for this work); `apps/api/test/refund-browser-check.ts` on that branch | **Feature is real and tested, but not on `develop`.** The 3 live `pos_refunds` rows are from that other branch sharing this Supabase project — not evidence of anything on `develop`. Not a bug; a merge-status fact. |
| Users/roles (owner/manager/cashier gating) | `store_memberships.role` checked directly in SQL/middleware across routes | Every gated route | store_memberships | No | `apps/api/src/routes/reports.ts:10-13`, `catalog.ts`, `customers.ts`, `audit.ts`, `auth.ts`, `terminal-auth/routes.ts` (all grep-confirmed to reference `store_memberships`/role checks) | **BACKED** |
| Shifts / cash drawer | N/A | N/A | N/A | N/A | Grepped for "shift"/"cash drawer"/till-count concepts — none found. `terminal_cashier_sessions` is a PIN-login auth session (15-min token), not a shift/drawer-count record. | **Feature does not exist in this codebase** — a scope gap to flag for product, not a persistence bug. |

**Full create/update/delete/tombstone tracing, and the complete UI-action inventory, were not exhaustively walked file-by-file** for every screen in `apps/web/src/screens` in this pass — time-boxed to the highest-value paths (checkout, catalog, customers, onboarding). Treat unlisted features as UNVERIFIED rather than assumed working.

## 5. Offline-first correctness audit (static code read)

1. **Outbox exists and is Dexie-persisted** (`outbox` table, `apps/web/src/lib/db.ts:141-159`) — survives reload/browser restart because Dexie = IndexedDB, not memory. Confirmed by schema, not by an actual reload test.
2. **Idempotency**: `operation_id` is a unique-indexed UUID (`&operation_id` in Dexie schema, `pos_operation_ledger` table server-side) and the sync engine checks `body.operation_id === entry.operation_id` before marking synced (`order-sync-core.ts` in `pushOrdersForStore`). The fixed-and-run `customer-browser-check.ts` (§6) confirms the ledger's last two rows are exactly `['customer', 'order']` after a real offline-then-reconnect sync — i.e. dedupe-relevant bookkeeping is genuinely populated by a real sync, not just present in schema. A dedicated *replay-the-same-operation-twice* assertion was not added this pass; that specific scenario remains UNVERIFIED by E2E, though the unique index on `operation_id` makes accidental duplication structurally unlikely.
3. **Retry/backoff**: exponential backoff capped at 300s (`nextAttempt`, `order-sync-core.ts`), max lease 30s, connectivity failures retried indefinitely; `validation` and `authentication` failures are NOT auto-retried (`failure_kind !== 'validation'` gates in `retryOrderForStore`) — validation failures require manual review (`canRetrySync` in `order-sync.ts` disables retry for `validation`). This is surfaced to the user via `SYNC_STATE_LABELS` ("Rejected — needs review"), not silently dropped. **Good design.**
4. **Conflict resolution**: last-write-wins is implicit — `loadCatalog` fully replaces local products/categories/tax_rates from server snapshot each pull; no evidence of field-level merge. Client timestamps (`client_generated_at`) are used for ordering but the source of truth for catalog is always server on refresh. Order records do not appear to be editable after creation (append-only sale + separate refund flow), which sidesteps most LWW staleness risk for orders specifically. **UNVERIFIED** for any table that supports in-place update from two devices.
5. Grep for unchecked `error` on Supabase calls: not exhaustively swept this session (time-boxed) — spot check of the calls found in §"createClient" grep shows every one destructures and checks `error` before proceeding (e.g. `apps/web/src/App.tsx:61`, `apps/web/src/lib/catalog.ts:27`, `management-access.ts:27`). No unchecked-error call was found in the files read, but a full repo sweep was not completed — **mark this UNVERIFIED as exhaustive, not clean-by-full-audit**.
6. **"Saved locally" vs "synced" distinction**: yes — `SyncState`/`SYNC_STATE_LABELS` in `order-sync.ts:1-24` explicitly model `pending | in_flight | blocked | rejected | synced` and this is surfaced in `SyncCenterScreen.tsx` (not read line-by-line, but the type is clearly designed for UI consumption).

## 6. Executable E2E proof — Phase 5 status: **PARTIALLY RUN, 2 of 4 fixtures pass for real**

This pass got a writable service-role key and used it to fix and *actually execute* the existing Playwright fixtures in `apps/api/test/*-browser-check.ts` (these build the real web app, drive a real Chromium browser, and assert against a real Postgres — in-memory PGlite with the actual migration files replayed, or the real live DB). They had never been run against the current codebase and had rotted:

| Fixture | Result | What it proves / what's still blocking it |
|---|---|---|
| `catalog-browser-check.ts` | **PASS** | Real browser: add a product via the UI → confirmed committed to `pos_products`+`pos_stock`+`pos_change_feed` → confirmed instantly sellable at `/register`, no manual refresh. Fixed one stale fixture gap (`/rest/v1/stores` wasn't mocked for the newer onboarding-status check). |
| `customer-browser-check.ts` | **PASS** | The closest thing to the report's "killer test": a cashier creates a customer and completes a cash sale **fully offline**; both survive a page reload while still offline (0 rows server-side, confirmed); on reconnect, exactly 1 customer row and 1 order row land in Supabase, in the correct dependency order (customer before order). Required 3 real fixes: the `/rest/v1/stores` gap, replaying all 15 migrations instead of a stale 5-migration subset (the missing 10 included `cart_discounts.sql`, whose absence caused a live column-does-not-exist error), and explicitly seeding a product since new stores no longer auto-seed a demo catalog. Also surfaced a real product gap — see new P2 in §7. |
| `reporting-browser-check.ts` | **Still fails — left open per instruction to stop this pass** | Fixed the same `/rest/v1/stores` gap; got far enough to see the real Dexie-computed daily report render correct numbers on screen. Fails later because this fixture's mini API server never mocks `/api/reports/...`, so the "Sales by cashier" panel gets the SPA's HTML back and can't parse it as JSON, which then blocks the fixture's own "Reporting unavailable" negative-path assertion from ever being reached. Needs the same real-`/api`-mount pattern `catalog-browser-check.ts` already uses. |
| `browser-check.ts` (terminal auth lifecycle) | **Not attempted this pass** | Same class of likely staleness; stopped here per explicit instruction before reaching it. |

**Duplicate-submit / replay-twice** and **delete-propagation** scenarios from the original Phase 5 spec were not added as new tests this pass (time-boxed, stopped early per instruction) — still UNVERIFIED. A real Supabase Auth test user (`bismamunir474+qatest@gmail.com`) and store were created for future E2E work that needs a real login instead of a fixture identity server, but no test in this pass ended up needing it — the existing fixture-identity-server pattern was sufficient and required no live account.

## 7. Senior engineer review (P0–P3)

**P1 — FIXED, verified live.** RLS enabled with 0 policies on 8 tables (§3.2). Migration `202609200001_service_role_only_rls_policies.sql` applied and confirmed; guard test added (`apps/web/tests/service-role-only-tables.test.ts`).

**P2 — FIXED, tested.** Stock-adjustment reconciliation gap (was `apps/web/src/lib/catalog.ts:100-108`): fixed in `apps/web/src/lib/order-sync-core.ts`'s `finish()` — a permanently-`validation`-rejected order's `stock_adjustments` rows are now explicitly deleted instead of left to rot with no `accepted_checkpoint` to ever trigger their cleanup. New unit test proves it; one pre-existing test's assertion (describing the old buggy behavior) was corrected to match.

**P2 — FIXED.** No Supabase migration ledger present in the database (§3.1). `supabase/migrations/APPLIED.md` now serves as a checked ledger (checksum + confirmed-live-object per file), verifiable any time via `apps/api/scripts/verify-migrations.mjs`.

**P2 — NEW finding this pass, not yet fixed.** The Receipt screen (`apps/web/src/receipts/ReceiptScreen.tsx`) and cashier shell (`apps/web/src/terminal-auth/CashierPosLayout.tsx`) have no sync trigger of their own — only `RegisterScreen.tsx:76-77` and `OrderHistoryScreen.tsx:44-46` register an `online` listener + 15s poll. Since completing a sale now navigates straight to Receipt (receipt-first UX, confirmed via `apps/web/src/screens/PaymentScreen.tsx:48`), a cashier who completes a sale and stays on the resulting Receipt page while the device reconnects will not see that sale sync until they manually navigate to Sell or Orders. *Why it matters*: this directly contradicts the "does data actually reach Supabase" goal in spirit — the data isn't lost, but it can sit un-synced far longer than the design intends, purely because of which screen happens to be on top. *Fix*: add the same `online`-listener + interval pattern (or better, lift it into `CashierPosLayout` once, so every cashier screen benefits) so reconnect-triggered sync isn't screen-dependent. Discovered via real E2E execution (`customer-browser-check.ts`, §6), not static reading — the test only passed once changed to navigate to Orders after reconnecting.

**P3 — RESOLVED for reports/refunds/roles, still open for shifts.** Reports confirmed BACKED via 5 passing integration tests against the real DB. Refunds confirmed real-and-tested but on an unmerged branch, not `develop` — a merge-status fact, not a defect. Roles/memberships confirmed BACKED via grep across every gated route. Shifts/cash-drawer: confirmed as **not implemented at all** in this codebase (not a persistence bug — a scope gap for product to weigh in on).

**P3 — PARTIALLY RESOLVED.** Phase 5 (executable E2E): 2 of 4 existing browser-check fixtures now actually run and pass with real proof; 1 is fixed partway and blocked on a missing `/api` mock; 1 was not attempted (stopped per explicit instruction). Duplicate-submit-replay and delete-propagation scenarios from the original spec remain unwritten. Treat reporting's *client-rendered* dashboard and terminal-auth lifecycle as one level below live UI-driven proof still; everything else in this list now has it.

**Positive findings worth keeping**: integer-cents money end-to-end (schema + Dexie types, §3.3); idempotent operation IDs with a server-side operation ledger, now shown populated correctly by a real executed sync; exponential-backoff retry with a clear rejected/blocked/pending/in-flight/synced state machine surfaced to the UI; RLS now has an explicit policy on every public table (no blanket RLS-off data leak, and no more silent-deny-by-omission either); no service-role key found anywhere under `apps/web` in this session's greps; the offline-then-reconnect-then-correct-dependency-order sync behavior is now proven by a real passing E2E test, not just code reading.

## 8. Fix plan (smallest first)

1. ~~Document (or explicitly policy-gate) the 8 zero-policy RLS tables~~ — **done** (migration applied live, guard test added).
2. ~~Fix stock-adjustment rollback on permanent validation failure~~ — **done** (fixed + tested).
3. ~~Re-establish a migration ledger~~ — **done** (`APPLIED.md` + `verify-migrations.mjs`).
4. ~~Complete traceability for reports, refunds, shifts, and roles~~ — **done** (§4); shifts confirmed as a real scope gap, not a bug.
5. **Fix the Receipt-screen sync-trigger gap** (new P2, §7): add an `online`-listener + interval sync call reachable from every cashier screen, not just Register and Orders. (~1-2 hrs incl. a regression test.)
6. **Fix `reporting-browser-check.ts`**: mount a real `/api` route (or an explicit mock) for `/api/reports/...` in that fixture, the same way `catalog-browser-check.ts` already does, so the client-rendered dashboard gets real E2E proof instead of stopping partway. (~1-2 hrs.)
7. **Run `browser-check.ts`** (terminal auth lifecycle) — not attempted this pass; likely needs the same class of fixture repair as the other three. (~1-3 hrs depending on how stale it is.)
8. **Add the two still-missing Phase 5 scenarios**: replay-the-same-`operation_id`-twice (duplicate protection) and delete-propagation (does this codebase even have a delete path for any of these entities? — check before assuming one needs to be tested). (~2-4 hrs.)
9. Decide whether/when to merge `feat/store-settings-and-catalog-extensions` (the refunds branch) into `develop` — a product/release-planning decision, not a code fix.

---
*Redaction note: all `.env`/`.env.local` values (DATABASE_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY, the QA test user's password, etc.) were read only to establish connections and perform the actions described above; none are reproduced anywhere in this report.*
