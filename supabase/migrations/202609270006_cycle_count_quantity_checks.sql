-- pos_cycle_count_items.expected_quantity/counted_quantity had no non-negative check, unlike
-- almost every other quantity/amount column in this schema. The app already only ever writes
-- non-negative values on both write paths (the expected-quantity snapshot insert sources from
-- pos_stock.current_stock defaulting to 0; counted_quantity is rejected below 0 before the update
-- in inventory.ts), so this is safe and purely closes the gap at the DB layer too.
alter table public.pos_cycle_count_items
  add constraint pos_cycle_count_items_expected_quantity_check check (expected_quantity >= 0),
  add constraint pos_cycle_count_items_counted_quantity_check check (counted_quantity is null or counted_quantity >= 0);
