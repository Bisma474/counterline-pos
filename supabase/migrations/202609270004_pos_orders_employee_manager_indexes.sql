-- pos_orders.employee_id and manager_id have FKs but no supporting index, unlike every other
-- store-scoped filter column on this table. Cashier-shift and manager-approval reporting queries
-- filter/join on these — as order volume grows this forces a sequential scan per store. `create
-- index concurrently` so this never locks pos_orders on the live table; each statement must run on
-- its own (concurrently cannot run inside a transaction block), so run these one at a time.
create index concurrently if not exists pos_orders_employee
  on public.pos_orders(store_id, employee_id) where employee_id is not null;

create index concurrently if not exists pos_orders_manager
  on public.pos_orders(store_id, manager_id) where manager_id is not null;
