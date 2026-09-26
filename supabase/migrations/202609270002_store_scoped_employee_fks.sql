-- pos_refunds.approved_by_employee_id, audit_log.actor_employee_id and
-- pos_inventory_movements.actor_employee_id were added as bare `references terminal_employees(id)`
-- FKs, unlike every other cross-table reference to terminal_employees in this schema (pos_orders,
-- terminal_cashier_sessions), which use the composite (store_id, employee_id) pattern against
-- terminal_employees' existing unique(store_id, id). A bare FK only checks the id exists anywhere,
-- not that it belongs to the row's own store — so an employee from an unrelated store could
-- legally be recorded as the approver/actor. The API already only ever writes matching
-- store_id/employee_id pairs (both come from the same store-checked Actor), so this tightens the
-- constraint to match what's already true in practice, without requiring any app change.
alter table public.pos_refunds
  drop constraint if exists pos_refunds_approved_by_employee_id_fkey,
  add constraint pos_refunds_approved_by_employee_id_fkey
    foreign key (store_id, approved_by_employee_id) references public.terminal_employees(store_id, id);

alter table public.audit_log
  drop constraint if exists audit_log_actor_employee_id_fkey,
  add constraint audit_log_actor_employee_id_fkey
    foreign key (store_id, actor_employee_id) references public.terminal_employees(store_id, id);

alter table public.pos_inventory_movements
  drop constraint if exists pos_inventory_movements_actor_employee_id_fkey,
  add constraint pos_inventory_movements_actor_employee_id_fkey
    foreign key (store_id, actor_employee_id) references public.terminal_employees(store_id, id);
