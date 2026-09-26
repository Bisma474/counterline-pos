-- Batch D (deferred from the schema-hardening pass): pos_refunds.amount_cents had no DB-level
-- enforcement tying it to anything else. Two invariants are guaranteed by construction in
-- apps/api/src/routes/orders.ts's performRefund() today, but only at the application layer:
--
-- 1. pos_refunds.amount_cents always equals the sum of that refund's own pos_refund_items rows —
--    it's literally computed as `toRefund.reduce((sum, item) => sum + item.amount_cents, 0)` and
--    inserted in the same transaction as the items themselves.
-- 2. A single order_item can never be refunded (cumulatively, across any number of partial
--    refunds) for more than its own total_cents — packages/domain/src/money.ts's
--    splitOrderItemRefundAmount() bounds every refunded amount against
--    `alreadyRefundedAmountCents`/`totalCents`, and always assigns the exact remaining amount
--    (not a rounded share) to whichever refund fully exhausts an item's remaining quantity, so
--    rounding can never let the cumulative sum drift past the original total.
--
-- Both were verified against every existing pos_refunds/pos_refund_items row before writing this
-- migration — zero violations found. These triggers are a defense-in-depth backstop matching the
-- existing trg_pos_refund_items_enforce_quantity trigger's own stated purpose (from
-- 202609230001_partial_refunds.sql): "so the invariant holds even if some future code path writes
-- to pos_refund_items directly" — not the primary UX, which stays the API's own 422 responses.

-- 1. Extend the existing quantity-enforcement trigger to also enforce the amount cap per
-- order_item, alongside its original quantity cap. Same function name/trigger, just a fuller body.
create or replace function public.pos_refund_items_enforce_quantity() returns trigger as $$
declare
  v_original_qty integer;
  v_original_total_cents bigint;
  v_already_refunded integer;
  v_already_refunded_amount bigint;
begin
  select quantity, total_cents into v_original_qty, v_original_total_cents
  from public.pos_order_items
  where id = new.order_item_id and store_id = new.store_id;

  if v_original_qty is null then
    raise exception 'order_item % not found for store %', new.order_item_id, new.store_id;
  end if;

  select coalesce(sum(quantity), 0), coalesce(sum(amount_cents), 0)
    into v_already_refunded, v_already_refunded_amount
  from public.pos_refund_items
  where store_id = new.store_id
    and order_item_id = new.order_item_id
    and id <> new.id;

  if v_already_refunded + new.quantity > v_original_qty then
    raise exception 'refund quantity % exceeds remaining % for order_item %',
      new.quantity, v_original_qty - v_already_refunded, new.order_item_id
      using errcode = '23514';
  end if;

  if v_already_refunded_amount + new.amount_cents > v_original_total_cents then
    raise exception 'refund amount % exceeds remaining % cents for order_item %',
      new.amount_cents, v_original_total_cents - v_already_refunded_amount, new.order_item_id
      using errcode = '23514';
  end if;

  return new;
end;
$$ language plpgsql;

-- 2. New: pos_refunds.amount_cents must equal the sum of its own pos_refund_items.amount_cents.
-- Deferred to end-of-transaction (not checked per-row) because performRefund() inserts the
-- pos_refunds header row first, then its items one at a time in a loop — a same-transaction,
-- non-deferred per-row check would reject every insert before the last one, since the running sum
-- is necessarily incomplete until the loop finishes. INITIALLY DEFERRED re-runs this check once
-- per row change, but only at commit time, by which point every item row already exists.
create or replace function public.pos_refunds_enforce_amount_matches_items() returns trigger as $$
declare
  v_refund_id uuid;
  v_header_amount bigint;
  v_items_amount bigint;
begin
  v_refund_id := coalesce(new.refund_id, old.refund_id);

  select amount_cents into v_header_amount
  from public.pos_refunds
  where id = v_refund_id;

  if v_header_amount is null then
    -- The refund header row doesn't exist (or was removed) in the visible state at commit time —
    -- refunds are append-only in this schema, so this should never happen in normal operation;
    -- nothing to compare against either way.
    return null;
  end if;

  select coalesce(sum(amount_cents), 0) into v_items_amount
  from public.pos_refund_items
  where refund_id = v_refund_id;

  if v_items_amount <> v_header_amount then
    raise exception 'pos_refunds.amount_cents (%) does not match the sum of its pos_refund_items.amount_cents (%) for refund %',
      v_header_amount, v_items_amount, v_refund_id
      using errcode = '23514';
  end if;

  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_pos_refunds_enforce_amount_matches_items on public.pos_refund_items;
create constraint trigger trg_pos_refunds_enforce_amount_matches_items
  after insert or update or delete on public.pos_refund_items
  deferrable initially deferred
  for each row execute function public.pos_refunds_enforce_amount_matches_items();
