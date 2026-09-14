-- Counterline offline POS foundation. Apply after 202609130001_auth_and_stores.sql.
-- Browser clients do not receive database credentials for these tables; the Express API owns writes.

do $$ begin
  create type public.pos_payment_method as enum ('cash', 'external_card');
  create type public.pos_sync_status as enum ('pending', 'in_flight', 'blocked', 'rejected', 'synced');
exception when duplicate_object then null;
end $$;

create table public.pos_employees (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  display_name text not null,
  pin_salt bytea not null,
  pin_verifier bytea not null,
  verifier_version smallint not null default 1,
  active boolean not null default true,
  permission_version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (store_id, id),
  constraint pos_employee_name_length check (char_length(trim(display_name)) between 1 and 120)
);

create table public.pos_installations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  receipt_prefix text not null unique,
  receipt_sequence bigint not null default 0 check (receipt_sequence >= 0),
  active boolean not null default true,
  last_server_validated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (store_id, id)
);

create table public.pos_device_sessions (
  id uuid primary key default gen_random_uuid(),
  installation_id uuid not null references public.pos_installations(id) on delete cascade,
  refresh_token_hash bytea not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.pos_products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  barcode text,
  name text not null,
  category text not null default 'Uncategorized',
  unit_price_cents bigint not null check (unit_price_cents between 0 and 1000000000),
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 10000),
  active boolean not null default true,
  catalog_version bigint not null default 1,
  server_stock integer not null default 0,
  unique (store_id, sku),
  unique (store_id, barcode)
);

create table public.pos_orders (
  id uuid primary key,
  store_id uuid not null references public.stores(id),
  installation_id uuid not null references public.pos_installations(id),
  employee_id uuid not null,
  receipt_number text not null,
  client_generated_at timestamptz not null,
  subtotal_cents bigint not null check (subtotal_cents between 0 and 1000000000),
  tax_cents bigint not null check (tax_cents between 0 and 1000000000),
  total_cents bigint not null check (total_cents = subtotal_cents + tax_cents),
  created_at timestamptz not null default now(),
  unique (installation_id, receipt_number)
);

create table public.pos_order_items (
  id uuid primary key,
  order_id uuid not null references public.pos_orders(id) on delete cascade,
  product_id uuid not null,
  product_name text not null,
  sku text not null,
  unit_price_cents bigint not null check (unit_price_cents between 0 and 1000000000),
  quantity integer not null check (quantity between 1 and 10000),
  tax_rate_bps integer not null check (tax_rate_bps between 0 and 10000),
  catalog_version bigint not null,
  line_subtotal_cents bigint not null,
  line_tax_cents bigint not null,
  line_total_cents bigint not null,
  check (line_total_cents = line_subtotal_cents + line_tax_cents)
);

create table public.pos_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.pos_orders(id) on delete cascade,
  method public.pos_payment_method not null,
  amount_cents bigint not null check (amount_cents between 0 and 1000000000),
  tendered_cents bigint not null check (tendered_cents between 0 and 1000000000),
  change_cents bigint not null check (change_cents between 0 and 1000000000),
  external_reference text,
  check ((method = 'cash' and tendered_cents - amount_cents = change_cents) or (method = 'external_card' and tendered_cents = amount_cents and change_cents = 0))
);

create table public.pos_operation_ledger (
  store_id uuid not null references public.stores(id) on delete cascade,
  operation_id uuid not null,
  installation_id uuid not null references public.pos_installations(id),
  entity_type text not null check (entity_type in ('order', 'customer')),
  payload_hash text not null,
  status public.pos_sync_status not null default 'pending',
  accepted_checkpoint bigint,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (store_id, operation_id)
);

create table public.pos_inventory_movements (
  store_id uuid not null references public.stores(id) on delete cascade,
  operation_id uuid not null,
  product_id uuid not null,
  quantity_delta integer not null,
  created_at timestamptz not null default now(),
  primary key (store_id, operation_id, product_id)
);

create table public.pos_sync_feed_state (
  store_id uuid primary key references public.stores(id) on delete cascade,
  next_position bigint not null default 0 check (next_position >= 0)
);

create table public.pos_change_feed (
  store_id uuid not null references public.stores(id) on delete cascade,
  position bigint not null,
  entity_type text not null,
  entity_id uuid not null,
  action text not null check (action in ('upsert', 'delete')),
  version bigint not null,
  payload jsonb,
  created_at timestamptz not null default now(),
  primary key (store_id, position)
);

create index pos_products_search on public.pos_products(store_id, active, category);
create index pos_orders_history on public.pos_orders(installation_id, client_generated_at desc);
create index pos_feed_page on public.pos_change_feed(store_id, position);

alter table public.pos_employees enable row level security;
alter table public.pos_installations enable row level security;
alter table public.pos_device_sessions enable row level security;
alter table public.pos_products enable row level security;
alter table public.pos_orders enable row level security;
alter table public.pos_order_items enable row level security;
alter table public.pos_payments enable row level security;
alter table public.pos_operation_ledger enable row level security;
alter table public.pos_inventory_movements enable row level security;
alter table public.pos_sync_feed_state enable row level security;
alter table public.pos_change_feed enable row level security;

revoke all on all tables in schema public from anon, authenticated;
