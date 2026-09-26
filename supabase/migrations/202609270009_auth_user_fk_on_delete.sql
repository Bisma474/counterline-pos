-- pos_refunds.refunded_by, audit_log.actor_id, and pos_cycle_counts.started_by/submitted_by all
-- referenced auth.users(id) with no ON DELETE behavior (defaulting to NO ACTION), blocking any
-- future user-account deletion once that user has any history at all. Per product decision:
-- preserve the historical record but anonymize the actor, rather than block deletion outright.
-- refunded_by/actor_id/submitted_by are already nullable (the xor constraints added alongside the
-- terminal-employee alternate-actor columns made them so); started_by was still not null, so it
-- must be loosened too for "set null on delete" to be possible at all — a cycle count whose
-- starter's account was later deleted should keep existing, not become an invalid row.
alter table public.pos_refunds
  drop constraint pos_refunds_refunded_by_fkey,
  add constraint pos_refunds_refunded_by_fkey
    foreign key (refunded_by) references auth.users(id) on delete set null;

alter table public.audit_log
  drop constraint audit_log_actor_id_fkey,
  add constraint audit_log_actor_id_fkey
    foreign key (actor_id) references auth.users(id) on delete set null;

alter table public.pos_cycle_counts
  alter column started_by drop not null,
  drop constraint pos_cycle_counts_started_by_fkey,
  add constraint pos_cycle_counts_started_by_fkey
    foreign key (started_by) references auth.users(id) on delete set null,
  drop constraint pos_cycle_counts_submitted_by_fkey,
  add constraint pos_cycle_counts_submitted_by_fkey
    foreign key (submitted_by) references auth.users(id) on delete set null;
