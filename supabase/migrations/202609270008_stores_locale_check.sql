-- stores.locale existed live (not null, default 'en-US') but was never part of any committed
-- migration file at all — a fresh database built from just these migrations never had this
-- column, unlike the live database, which picked it up from an out-of-band change. Create it
-- (if missing) with the same shape it already has live, then add the missing format constraint —
-- unlike every sibling column on this table (name, currency, country, address all have one).
-- It's not read anywhere in apps/api or apps/web today, but existing live rows already carry
-- real, differing values (e.g. 'en-PK'), so it's live, populated data, not dead weight; add the
-- constraint instead of dropping the column.
alter table public.stores
  add column if not exists locale text not null default 'en-US';
alter table public.stores
  add constraint stores_locale_format check (locale ~ '^[a-z]{2}-[A-Z]{2}$');
