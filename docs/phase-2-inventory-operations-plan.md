# Phase 2: Inventory Operations — Dependency Plan

## Stockable entity contract (decided)

Product variants do not exist anywhere in this codebase or its docs (only false-positive grep
matches on "invariant(s)"). Building a full variant/attribute catalog system is not in the
FEATURES TO BUILD list and would be its own large feature, not "inventory operations." Decision:

- **Do not build a variants schema now.** `pos_products` remains the only stockable entity table;
  `pos_stock`/`pos_products` schema is untouched (zero risk to checkout/catalog/refunds).
- **Do establish the contract at the domain/TypeScript layer**: a single `StockableRef` type and
  one resolver, so a future variant type is one new case in one place, not scattered
  `if product... else if variant...` checks. This satisfies "one clean domain contract" honestly,
  without inventing schema for a feature that doesn't exist.

## What already exists and must be reused, not replaced
- Offline stock overlay: `posDb.stock_adjustments` (local delta overlay reconciled by `loadCatalog`
  against `accepted_checkpoint`). Phase 2 adjustments are **online-only** (spec requirement) — they
  never touch this table; they write `posDb.server_stock` directly after a synchronous API success,
  exactly like product creation already does. Zero changes to the offline sale overlay model.
- `pos_inventory_movements` (existing ledger: store_id, product_id, order_id, operation_id, delta,
  reason, server_received_at). Extend additively (new nullable columns), never restructure.
- `requireStoreManager` (apps/api/src/routes/auth.ts) — reused as-is for owner/manager gating,
  matching stores.ts/catalog.ts/orders.ts's refund endpoint.
- Change feed (`pos_change_feed`, entity_type check) — extend the allow-list, same pattern as every
  prior feature this project has added (product, tax_rate, refund).
- Audit log (`audit_log` table, `action`/`target` free-text convention) — reuse as-is, same
  `action.verb` / short descriptive `target` string convention already used by terminal-auth routes.
- Service-role-only RLS pattern (`202609200001_service_role_only_rls_policies.sql` +
  `apps/web/tests/service-role-only-tables.test.ts` guard) — new tables follow this exact pattern.

## New migration (one file, ordered)
1. `pos_products.low_stock_threshold integer not null default 5` — default matches today's
   hardcoded UI threshold exactly, so existing products show identically until someone changes it.
2. `pos_inventory_movements` additive columns: `old_quantity`, `new_quantity` (nullable — **not**
   backfilled onto existing sale/refund/opening_stock rows; only new Phase-2 writes populate them,
   to avoid touching checkout/refund transaction code for a cosmetic backfill), `note`,
   `adjustment_reason` (checked enum, required exactly when reason='manual_adjustment'), `actor_id`,
   `cycle_count_id`. Widen the `reason` check to add `manual_adjustment`/`cycle_count`.
3. `pos_cycle_counts` (session) + `pos_cycle_count_items` (per-product expected/counted/variance).
4. Add `pos_cycle_counts`/`pos_cycle_count_items` to the change-feed entity_type check? No —
   individual stock changes from a submitted count already get `entity_type='stock'` movements via
   the same path as every other stock change; the session itself doesn't need its own feed entity.
5. RLS: enable + service-role-only deny-all policy on both new tables, add both to the guard test.

## New API (apps/api/src/routes/inventory.ts, mounted once)
- `GET /inventory` — list (store-scoped, owner/manager)
- `GET /inventory/movements` — ledger, optional `product_id` filter
- `PATCH /inventory/threshold` — update one product's low_stock_threshold
- `POST /inventory/adjust` — manual adjustment (one transaction, 12-step sequence)
- `POST /inventory/cycle-counts` — start a session with selected products (snapshot expected qty)
- `GET /inventory/cycle-counts/:id` — view session + items
- `PATCH /inventory/cycle-counts/:id/items/:itemId` — record a counted quantity (no stock mutation)
- `POST /inventory/cycle-counts/:id/submit` — one transaction: re-lock live stock per item (not the
  stale snapshot), apply variance only where non-zero, skip movement/audit/feed writes for
  zero-variance items entirely
- `POST /inventory/cycle-counts/:id/cancel` — mark cancelled, no stock effect

## Execution order
1. Branch from latest `develop`.
2. Migration (this file's plan) — verify locally against PGlite before writing API code against it.
3. Backend: domain helpers (`StockableRef`, transaction service) + all inventory.ts routes, done
   sequentially by the orchestrator (this is the highest-coupling, highest-risk part — not split
   across parallel agents).
4. Once the API contract is implemented and building cleanly: fan out in parallel —
   - Agent 1: Inventory Management Screen + Cycle Count UI (given the fixed API contract + existing
     product-catalog.css components).
   - Orchestrator (me), in parallel with Agent 1: the automated test suite (10 acceptance scenarios)
     against the same fixed contract, plus updating ProductCatalogScreen's stock-pill threshold to
     read the per-product value instead of the hardcoded 5.
5. Integrate, build, run full test suite, fix regressions.
6. Dedicated review/debugging pass (separate agent) against the full checklist in the task.
7. Final report.
