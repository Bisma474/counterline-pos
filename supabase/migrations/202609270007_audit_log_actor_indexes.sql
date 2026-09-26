-- audit_log only indexed (store_id, created_at desc) — a "what did this person do" query (a
-- natural audit-log use case, especially since actor is now split between actor_id/
-- actor_employee_id) had no covering index and had to scan the whole store's history.
create index concurrently if not exists audit_log_actor
  on public.audit_log(store_id, actor_id) where actor_id is not null;

create index concurrently if not exists audit_log_actor_employee
  on public.audit_log(store_id, actor_employee_id) where actor_employee_id is not null;
