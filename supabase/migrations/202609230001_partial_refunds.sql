-- Relax pos_refunds from "at most one whole-order refund, ever" to "any number of partial
-- refunds, as long as no line item is ever refunded past its originally sold quantity." Also
-- links a refund to the replacement order created for it, when it's the return-half of an
-- exchange (apps/api/src/routes/orders.ts's new POST /orders/:id/exchange).

-- pos_refunds.unique(store_id, order_id) was the whole-order-only gate. Drop it by looking up its
-- generated name rather than guessing it, matching the established convention for dropping
-- unnamed constraints in this schema (see 202609170002_cart_discounts.sql).
do $$
declare con_name text;
begin
  select conname into con_name from pg_constraint
    where conrelid = 'public.pos_refunds'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (store_id, order_id)';
  if con_name is not null then execute format('alter table public.pos_refunds drop constraint %I', con_name); end if;
end $$;

-- A refund is the return-half of an exchange when this is set, pointing at the replacement order
-- created alongside it. Purely a display/audit link — never an input to either row's own money
-- math (the refund's amount_cents and the new order's total_cents are each independently correct
-- on their own, exactly as if they'd happened separately).
alter table public.pos_refunds
  add column exchange_order_id uuid,
  add foreign key (store_id, exchange_order_id) references public.pos_orders(store_id, id);

-- Enforce "never refund more of a line item than was bought," across any number of partial
-- refunds. A check constraint can't do a cross-row SUM, so this is a trigger: a defense-in-depth
-- backstop, not the primary UX (the API performs the same check itself, inside the same
-- per-store lock every mutation already takes, to give a clean 422 instead of a raw DB error —
-- see orders.ts's refund()). This trigger exists so the invariant holds even if some future code
-- path writes to pos_refund_items directly.
create or replace function public.pos_refund_items_enforce_quantity() returns trigger as $$
declare
  v_original_qty integer;
  v_already_refunded integer;
begin
  select quantity into v_original_qty
  from public.pos_order_items
  where id = new.order_item_id and store_id = new.store_id;

  if v_original_qty is null then
    raise exception 'order_item % not found for store %', new.order_item_id, new.store_id;
  end if;

  select coalesce(sum(quantity), 0) into v_already_refunded
  from public.pos_refund_items
  where store_id = new.store_id
    and order_item_id = new.order_item_id
    and id <> new.id;

  if v_already_refunded + new.quantity > v_original_qty then
    raise exception 'refund quantity % exceeds remaining % for order_item %',
      new.quantity, v_original_qty - v_already_refunded, new.order_item_id
      using errcode = '23514';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger trg_pos_refund_items_enforce_quantity
  before insert or update on public.pos_refund_items
  for each row execute function public.pos_refund_items_enforce_quantity();

-- The over-refund check (app-level and the trigger above) sums pos_refund_items by order_item_id
-- on every refund/exchange request — index it, this table only grows.
create index if not exists idx_pos_refund_items_order_item
  on public.pos_refund_items (store_id, order_item_id);
