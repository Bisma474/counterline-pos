-- Phase 2: Inventory Operations — manual stock adjustments, cycle counts, and a per-product
-- low-stock threshold. Extends the existing pos_inventory_movements ledger and pos_products
-- table additively; does not touch pos_stock, pos_orders, pos_order_items, or any checkout/refund
-- write path. No product-variant schema is introduced — variants do not exist anywhere in this
-- codebase (see docs/phase-2-inventory-operations-plan.md) and building that catalog feature is
-- out of this phase's scope; the stockable-entity contract lives at the TypeScript domain layer
-- instead (apps/api/src/lib/stockable.ts), ready for a variant case to be added there later
-- without touching this schema.

-- 1. Configurable low-stock threshold. Default 5 matches today's hardcoded UI threshold exactly
-- (>5 in-stock, 1-5 low, <=0 out), so no existing product's displayed status changes until an
-- owner/manager explicitly edits it.
alter table public.pos_products
  add column low_stock_threshold integer not null default 5 check (low_stock_threshold >= 0);

-- 2. Extend the inventory ledger. old_quantity/new_quantity are nullable and deliberately left
-- null on every existing row (sale/opening_stock/refund) — backfilling them would mean touching
-- the checkout and refund transactions for a cosmetic improvement, which this phase's own rules
-- forbid. Only new Phase-2 writes (manual_adjustment, cycle_count) populate them.
alter table public.pos_inventory_movements
  add column old_quantity integer,
  add column new_quantity integer,
  add column note text check (note is null or char_length(trim(note)) <= 500),
  add column adjustment_reason text check (adjustment_reason is null or adjustment_reason in
    ('damaged', 'expired', 'lost', 'received', 'correction', 'other')),
  add column actor_id uuid references auth.users(id),
  add column cycle_count_id uuid;

alter table public.pos_inventory_movements
  drop constraint pos_inventory_movements_reason_check;
alter table public.pos_inventory_movements
  add constraint pos_inventory_movements_reason_check
  check (reason in ('sale', 'opening_stock', 'refund', 'manual_adjustment', 'cycle_count'));

-- A manual adjustment must carry both a reason code and a note (spec: "a note is required for
-- every manual adjustment"); every other reason must leave adjustment_reason null, since it
-- doesn't apply. `note is not null` is spelled out explicitly (not left to the `> 0` comparison
-- alone) because a bare `char_length(trim(note)) > 0` evaluates to unknown, not false, when note
-- is null, and an unknown check-constraint expression is satisfied rather than rejected.
alter table public.pos_inventory_movements
  add constraint pos_inventory_movements_manual_adjustment_evidence check (
    (reason = 'manual_adjustment' and adjustment_reason is not null and note is not null and char_length(trim(note)) > 0)
    or (reason <> 'manual_adjustment' and adjustment_reason is null)
  );

-- A cycle-count variance must always trace back to the session that produced it, and no other
-- reason may claim one (mirrors the manual_adjustment_evidence guard above for the same field).
alter table public.pos_inventory_movements
  add constraint pos_inventory_movements_cycle_count_evidence check (
    (reason = 'cycle_count') = (cycle_count_id is not null)
  );

-- 3. Cycle count sessions.
create table public.pos_cycle_counts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  status text not null default 'open' check (status in ('open', 'submitted', 'cancelled')),
  started_by uuid not null references auth.users(id),
  started_at timestamptz not null default now(),
  submitted_by uuid references auth.users(id),
  submitted_at timestamptz,
  note text check (note is null or char_length(trim(note)) <= 500),
  check ((status = 'submitted') = (submitted_by is not null and submitted_at is not null)),
  unique (store_id, id)
);
create index pos_cycle_counts_by_store on public.pos_cycle_counts(store_id, started_at desc);

alter table public.pos_inventory_movements
  add constraint pos_inventory_movements_cycle_count_fkey
  foreign key (store_id, cycle_count_id) references public.pos_cycle_counts(store_id, id);

-- expected_quantity is a snapshot for display while counting is in progress; the authoritative
-- comparison at submit time re-reads live pos_stock under a row lock, not this snapshot, so a
-- sale that happens mid-count can never be silently overwritten by a stale expectation.
create table public.pos_cycle_count_items (
  id uuid primary key default gen_random_uuid(),
  cycle_count_id uuid not null,
  store_id uuid not null,
  product_id uuid not null,
  expected_quantity integer not null,
  counted_quantity integer,
  counted_at timestamptz,
  unique (cycle_count_id, product_id),
  foreign key (store_id, cycle_count_id) references public.pos_cycle_counts(store_id, id),
  foreign key (store_id, product_id) references public.pos_products(store_id, id)
);
create index pos_cycle_count_items_by_count on public.pos_cycle_count_items(cycle_count_id);

-- 4. RLS: service-role-only, same pattern as every other API-write-only table in this schema
-- (see 202609200001_service_role_only_rls_policies.sql). The API's raw pg.Pool connection
-- bypasses RLS entirely; these deny-all policies just make that fact explicit and machine-checked
-- (apps/web/tests/service-role-only-tables.test.ts is updated alongside this migration).
alter table public.pos_cycle_counts enable row level security;
alter table public.pos_cycle_count_items enable row level security;
create policy pos_cycle_counts_service_role_only on public.pos_cycle_counts
  for all to authenticated, anon using (false);
create policy pos_cycle_count_items_service_role_only on public.pos_cycle_count_items
  for all to authenticated, anon using (false);
