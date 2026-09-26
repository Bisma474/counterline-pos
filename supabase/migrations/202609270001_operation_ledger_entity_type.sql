-- pos_operation_ledger.entity_type only ever allowed ('order', 'customer'), but pos_change_feed's
-- equivalent constraint was widened five times since (product, tax_rate, refund, product_parent,
-- stock) without this table following along. Nothing writes those values into this table today
-- (every current insert either omits entity_type or writes 'customer'), so this is dormant —
-- purely future-proofing so a refund/product/tax-rate operation can be recorded in the idempotency
-- ledger with an honest entity_type once one ever needs to be.
alter table public.pos_operation_ledger
  drop constraint if exists pos_operation_ledger_entity_type_check;
alter table public.pos_operation_ledger
  add constraint pos_operation_ledger_entity_type_check
  check (entity_type in ('order', 'stock', 'product', 'customer', 'tax_rate', 'refund', 'product_parent'));
