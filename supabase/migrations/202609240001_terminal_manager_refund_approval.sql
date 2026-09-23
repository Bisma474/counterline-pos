-- Lets a PIN-based terminal manager (public.terminal_employees, role='manager') approve a
-- refund/exchange directly from the cashier terminal, without a web/email-password manager
-- account. A terminal employee has no auth.users row at all — refunded_by/actor_id/actor_id were
-- all `not null references auth.users(id)`, which a PIN-only manager can never satisfy. Rather
-- than force every terminal manager to also hold a web account, each of these gains a second,
-- alternate "who did this" column pointing at terminal_employees instead, with exactly one of the
-- two ever set — never both, never neither.

alter table public.pos_refunds
  alter column refunded_by drop not null,
  add column approved_by_employee_id uuid references public.terminal_employees(id),
  add constraint pos_refunds_approver_xor check (
    (refunded_by is not null) <> (approved_by_employee_id is not null)
  );

alter table public.audit_log
  alter column actor_id drop not null,
  add column actor_employee_id uuid references public.terminal_employees(id),
  add constraint audit_log_actor_xor check (
    (actor_id is not null) <> (actor_employee_id is not null)
  );

-- pos_inventory_movements.actor_id was already nullable (manual adjustments/cycle counts set it;
-- sales resolve their cashier via order_id -> pos_orders.employee_id instead, see
-- inventory.ts's listMovements). A terminal-approved refund's stock-reversal movement needs the
-- same alternate identity as the two tables above, for the same reason.
alter table public.pos_inventory_movements
  add column actor_employee_id uuid references public.terminal_employees(id);
