# Migration ledger

This project does not use the Supabase CLI's own `supabase_migrations.schema_migrations`
tracking (no `supabase/config.toml`, project not linked). That table does not exist in the live
database, so there was previously no DB-side source of truth for which of the files in this
directory are actually applied.

This file is that source of truth instead. Each row's checksum and "confirmed by" marker were
verified against the live database on 2026-09-19 by querying `information_schema`/`pg_catalog`
for an object each migration is responsible for creating (or, for a `drop`, for its absence) —
see `apps/api/scripts/verify-migrations.mjs`, which can be re-run at any time to re-confirm this
table stays accurate.

**When adding a new migration file**: add a row here in the same pass, with its SHA-256
(`sha256sum supabase/migrations/<file>.sql`) and the object you checked to confirm it applied. If
the checksum of an already-applied file in this table ever changes, that is drift — the live
schema no longer matches history, and it needs manual reconciliation, not a silent edit here.

| Migration file | SHA-256 | Applied | Confirmed by |
|---|---|---|---|
| 202609130001_auth_and_stores.sql | `db4c8a7d59a81ae6d887118f902f2255314e5bea846c522f433e82a77199290d` | yes | `public.stores` table exists |
| 202609150001_catalog_checkout_sync.sql | `6c2a609b648955c1a34892ffa266835baa58fb7ad3a75d7836ecc50cdc56e8d0` | yes | `public.pos_products` table exists |
| 202609150001_terminal_employee_access.sql | `039181c9c21ba546c3410ffc9da32d6760fadb2ba32d0b0a76214483f242edb2` | yes | `public.terminal_employees` table exists |
| 202609150002_terminal_device_sessions.sql | `0bf3498345debca810a195fee6229920dfe03ef5f1c874b6da352a7ebcd37dba` | yes | `public.terminal_device_sessions` table exists |
| 202609150003_team_profile_visibility.sql | `50b3d69b746ddd310bfa72eb2000371c87dc2a2ac2c8ef9a48a0c1871c953610` | yes | policy `store members can read teammate profiles` on `profiles` exists |
| 202609160001_customers_and_sale_attachment.sql | `9a0cdd6e7f2fc7cec5ec33ffda3d1bb380c203a49fe94ad1e5b3e9a88c5fad5b` | yes | `public.pos_customers` table exists |
| 202609170001_change_feed_product_entity.sql | `e6d4ee60379ca5eb15979790ddfc0fcd8bbf639f1c86e251e5f64a7f4b7a9600` | yes | `pos_change_feed.entity_type` column exists |
| 202609170002_cart_discounts.sql | `0d805e363807319826eded555bce0cb9ace1d02dffd4e70d29fd8dd7f7cf8b40` | yes | `pos_orders.discount_cents` column exists |
| 202609180001_terminal_name_uniqueness.sql | `98933a75e5053cc2bb7102ca4ff593b9f02d7c4fdd98a63c0d2467cf16d3f1d3` | yes | index `terminal_devices_store_name_active_idx` exists |
| 202609180002_pos_orders_report_read_access.sql | `00cb3ec9ecdf3406784d31f256cd4aaff8582b014fcd47e7ae2e73b2d08f9adc` | yes | `pos_orders.employee_id` column exists |
| 202609190001_audit_log.sql | `b3c51d6401fb2190399fb02f06554de77631867b927afc2b9abacea2f189b836` | yes | `public.audit_log` table exists |
| 202609190001_store_onboarding_status.sql | `95c85c7a40a52cbcab6279b7e976fe56511750aa6ddbd9cb53b226e4613d9422` | yes | function `complete_store_onboarding` exists |
| 202609190002_remove_demo_catalog_seed.sql | `3a53091f607da9d43874458a7cd3e9f01ae78f1b7c372b536dd3ee3961d18443` | yes | function `pos_seed_new_store` is absent (dropped) |
| 202609190003_store_sync_feed_init.sql | `8039268781ce168ec2887fd409ea620291565e30e8248b10eac52b9b76e916e2` | yes | function `pos_init_store_sync_state` exists |
| 202609200001_service_role_only_rls_policies.sql | `c5d91c60277e769cfd13c295a781ab5a0302082967d696bafd4bb7839d5731b1` | yes | policy `pos_change_feed_service_role_only` exists |
| 202609180002_store_business_details.sql | `19b48440443059196497bb0fa88744c135d7463e5832ec3bf98f7d1767f6389f` | yes | `stores.address` column exists |
| 202609180003_tax_rate_change_feed.sql | `932a86733a3c496e6f3443cdff8759abd6f7f7af2d31cee1180f23cfc34ffa81` | yes | `pos_change_feed_entity_type_check` allows `tax_rate` |
| 202609180004_product_images.sql | `9f108c7c0941c3dadd5a8d6c9284c051d8e966fbf1ef3a729744dc0907c14f7b` | yes | `pos_products.image_url` column exists |
| 202609180005_refunds.sql | `450b91896afcd3283bffd7658423ab68214a061983e0ee216bcc74618c61822f` | yes | `public.pos_refunds` table exists |
| 202609180006_stores_country_column.sql | `2ed67bda779dc138b0167b9211c96ac51937e03f414703958692359a4a3e9951` | yes | `stores.country` column exists |
| 202609220001_inventory_operations.sql | `91f0cffdb39c121e961f3fee90e91cf2b262f19119a03768e3e303fe04ef9dd3` | yes | `public.pos_cycle_counts` table exists |
| 202609220002_product_variants.sql | `d051e13ac1f2c0e8a5b2bb0583e0c9373615f5843fb840055eecddeb875d5957` | yes | `pos_change_feed_entity_type_check` allows `product_parent` |
| 202609230001_partial_refunds.sql | `984f17306e91064f317eb13ec8fe9c6538ce7553bf5420c0274a6307259c3527` | yes | `pos_refunds.exchange_order_id` column exists |
| 202609240001_terminal_manager_refund_approval.sql | `0d9a37448d242d50b3597062d9a1c4cb55ddfd42b288bb5c0dd2b37bdb0421c6` | yes | `pos_refunds.approved_by_employee_id` column exists |
| 202609260001_customer_phone_uniqueness.sql | `58612d0ed77b88872d08fb54ff437be0f894832fc644a63bd50f5fc2b82fb0ea` | yes | index `pos_customers_phone_unique` exists |
| 202609270001_operation_ledger_entity_type.sql | `34dc92b2c501aa4a91ad501cebf2e7a7552f26c17c53ea7d0e89eba7d7267224` | yes | `pos_operation_ledger_entity_type_check` allows `refund`/`product`/`product_parent` |
| 202609270002_store_scoped_employee_fks.sql | `06aaacbdedc36a50b8d8c87c5b419c95faed815c88f7da410ecdd840e8299e49` | yes | `pos_refunds_approved_by_employee_id_fkey` is composite `(store_id, approved_by_employee_id)` |
| 202609270003_refund_items_store_scoped_fk.sql | `cbca3739fd8a98bd3c1e520fe6faf4c0a5221530bf536e486f74dee99ec32d38` | yes | `pos_order_items_store_id_id_key` unique constraint exists |
| 202609270004_pos_orders_employee_manager_indexes.sql | `9b721cd005b6afb2168bc64bab8288cb719f3f16cdb9b0ab118b138d04fad2a5` | yes | indexes `pos_orders_employee`/`pos_orders_manager` exist |
| 202609270005_receipt_prefix_store_scoped.sql | `75fdb1ffb02d763c3e5a456a57e64b4eb75da44aa7d86921ed2a0a6f5863a2b3` | yes | `terminal_devices_receipt_prefix_key` is `UNIQUE (store_id, receipt_prefix)` |
| 202609270006_cycle_count_quantity_checks.sql | `e4ff0b757b13125cc10171d4d9951d9be9c5c7548898c0059e9df981ebc1cdb4` | yes | `pos_cycle_count_items_expected_quantity_check` exists |
| 202609270007_audit_log_actor_indexes.sql | `9db74be3363bd45855a35b448ecb15c2f3d71654b88fad910d5636350e396081` | yes | indexes `audit_log_actor`/`audit_log_actor_employee` exist |
| 202609270008_stores_locale_check.sql | `eb3a1099e6c4052780791cf3cf6291c434f4efda2980812ed3b282831712a450` | yes | `stores_locale_format` constraint exists |
| 202609270009_auth_user_fk_on_delete.sql | `9cbe33cf0d8cf693235b44c9ac31ff8b992ac891828d34a789fc407a30b7aa32` | yes | `pos_refunds_refunded_by_fkey`/`audit_log_actor_id_fkey`/`pos_cycle_counts_started_by_fkey`/`pos_cycle_counts_submitted_by_fkey` are all `ON DELETE SET NULL`, `started_by` is nullable |
| 202609270011_refund_amount_integrity.sql | `71b607ffa30f5cd524352a295e5617c9bacb46932e2d7cdc45683b72abee98e5` | yes | `pos_refunds_enforce_amount_matches_items` deferred constraint trigger + extended `pos_refund_items_enforce_quantity` exist |

All 15 originally-tracked files remain confirmed. The 9 files added between 2026-09-19 and
2026-09-26 (`202609180002` through `202609260001`) were previously untracked here despite being
live — confirmed individually via `information_schema`/`pg_constraint` on 2026-09-26 and backfilled
above. `202609270001` through `202609270009` were run through the Supabase SQL Editor and each
individually re-verified live on 2026-09-26 (a `202609270010`
customer-name-length migration was drafted but abandoned — the live `pos_customers_name_check` was
already found to be 1-160, not the 1-30 the original migration file claimed, so no DB change was
needed there; only the app-layer validators were brought in line with the DB instead).
`202609270011` (the deferred refund-amount-integrity trigger, Batch D) was verified against a
sandboxed PGlite copy of the full schema plus the real `orders.ts` refund endpoint
(`apps/api/test/refund-partial.test.ts`) before being run, then re-verified live on 2026-09-26
(both `pg_proc` function bodies and the trigger's `tgdeferrable`/`tginitdeferred` flags confirmed).

`202609270008` was amended after its initial live application: `stores.locale` turned out to exist
**only** on the live database, created out-of-band with no committed migration ever defining it —
a fresh database built from just these migration files never had the column at all, which
`apps/api/test/refund-partial.test.ts` caught (it builds its fixture from the committed files, not
the live DB). The file now does `add column if not exists locale ...` before the constraint, so a
fresh environment gets the same column live already has. This changed the file's checksum after
the fact; the live database's actual state is unaffected (the column already existed there), so no
re-run is needed — this is the documented reconciliation the ledger's own header asks for, not a
silent edit.

`202609270003` note: also discovered live that `pos_refunds` carries several columns
(`operation_id`, `external_reference`, `payment_outcome`, `reason_code`, `reason_note`) and a
`unique(store_id, operation_id)` constraint not present in any committed migration file — schema
drift beyond what this pass addresses, flagged here for a future reconciliation pass rather than
silently absorbed into one of these migrations.

**Test coverage note**: `apps/api/test/customer-api.test.ts` and `apps/api/test/refund-partial.test.ts`
were updated to include the new migrations in their fixture's migration list; `customer-api.test.ts`
also had a pre-existing assertion that depended on two customers sharing one phone number to test
cursor pagination — now updated to use two distinct (but prefix-sharing) phone numbers, since
`202609260001`'s per-store phone uniqueness (applied earlier, before this pass) made the old
scenario invalid, plus a new explicit assertion that a duplicate phone is rejected with
`duplicate_phone`. Other test files with their own hardcoded migration lists were not audited in
this pass and may need the same treatment before they'd catch a related regression.
