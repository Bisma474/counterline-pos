-- terminal_devices.receipt_prefix was globally unique across every store, unlike every other
-- identity-like column in this schema (terminal name, product sku, category name — all
-- unique(store_id, ...)). Two unrelated stores couldn't both provision a terminal named "A-"
-- purely by coincidence of a global constraint that added no real value: the app already derives
-- receipt_prefix from a random UUID (`${id.toUpperCase()}-`), so it's unique-by-construction
-- regardless of scope. The 23505 handler in terminal-auth/routes.ts doesn't check the constraint
-- name, so this is a behavior no-op — just correctly scoped.
alter table public.terminal_devices
  drop constraint if exists terminal_devices_receipt_prefix_key;
alter table public.terminal_devices
  add constraint terminal_devices_receipt_prefix_key unique (store_id, receipt_prefix);
