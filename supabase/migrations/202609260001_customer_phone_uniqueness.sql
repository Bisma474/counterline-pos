-- A phone number now identifies at most one customer per store.
drop index public.pos_customers_phone_lookup;
create unique index pos_customers_phone_unique on public.pos_customers(store_id, phone_normalized)
  where phone_normalized is not null;
