-- pos_refund_items.order_item_id referenced bare pos_order_items(id) — documented at the time as
-- "pos_order_items has no unique(store_id, id) to reference against" (202609160001's sibling
-- migration), with the API trusted to scope the lookup by store_id itself. Add that unique
-- constraint now (trivially satisfiable: id is already pos_order_items' global primary key, so
-- (store_id, id) is already unique) and tighten the FK to match every other tenant-scoped
-- reference in this schema, closing the documented gap.
alter table public.pos_order_items
  add constraint pos_order_items_store_id_id_key unique (store_id, id);

alter table public.pos_refund_items
  drop constraint if exists pos_refund_items_order_item_id_fkey,
  add constraint pos_refund_items_order_item_id_fkey
    foreign key (store_id, order_item_id) references public.pos_order_items(store_id, id);
