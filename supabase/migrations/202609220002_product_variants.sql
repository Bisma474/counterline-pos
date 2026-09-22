-- Existing products remain standalone sellable records. Parents are grouping records;
-- each variant keeps its own existing product ID, SKU, stock and sale references.
create table public.pos_product_parents (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 80),
  revision bigint not null default 1 check (revision > 0),
  unique (store_id, id)
);
alter table public.pos_product_parents enable row level security;
revoke all on public.pos_product_parents from anon, authenticated;
grant select on public.pos_product_parents to authenticated;
create policy pos_product_parents_member_read on public.pos_product_parents
  for select to authenticated using (public.is_store_member(store_id));
grant all on public.pos_product_parents to service_role;

alter table public.pos_products
  add column parent_product_id uuid,
  add column option_values jsonb not null default '{}'::jsonb,
  add column is_draft boolean not null default false,
  add constraint pos_products_parent_store_fk foreign key (store_id, parent_product_id)
    references public.pos_product_parents(store_id, id),
  add constraint pos_products_options_object check (jsonb_typeof(option_values) = 'object'),
  add constraint pos_products_variant_shape check (
    (parent_product_id is null and option_values = '{}'::jsonb and not is_draft)
    or (parent_product_id is not null and option_values <> '{}'::jsonb and (not is_draft or not active))
  );
create index pos_products_parent on public.pos_products(store_id, parent_product_id);
create unique index pos_products_variant_options on public.pos_products(store_id, parent_product_id, option_values)
  where parent_product_id is not null;

-- Never return a distributed variant to deletable draft state. A server cannot know
-- whether an offline browser already sold it. Ordinary products are unaffected.
create function public.pos_guard_variant_lifecycle() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.parent_product_id is not null then
    if tg_op = 'DELETE' and not old.is_draft then
      raise exception 'Published variants must be deactivated, not deleted' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' and (new.parent_product_id is distinct from old.parent_product_id
       or (not old.is_draft and new.is_draft)) then
      raise exception 'Variant identity and publication cannot be reset' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger pos_guard_variant_lifecycle before update or delete on public.pos_products
  for each row execute function public.pos_guard_variant_lifecycle();
revoke all on function public.pos_guard_variant_lifecycle() from public, anon, authenticated;

alter table public.pos_change_feed drop constraint pos_change_feed_entity_type_check;
alter table public.pos_change_feed add constraint pos_change_feed_entity_type_check
  check (entity_type in ('order','stock','product','customer','tax_rate','refund','product_parent'));
