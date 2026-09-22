# Phase 2 product variants

## Design and compatibility

Ordinary products stay in `pos_products` and keep their existing IDs, SKUs, stock and checkout behavior. A new store-scoped `pos_product_parents` table groups variants. A variant is an existing-style sellable product with nullable `parent_product_id`, structured `option_values`, and `is_draft`. Each variant has an independent product ID, store-scoped SKU, optional barcode, price, active state and stock row.

Parents are not sellable. Register cards group active variants by parent; the native modal picker displays options, SKU, price and projected stock. HID barcode/SKU + Enter adds the exact matching sellable record. Ambiguous legacy codes still show a choice rather than selecting silently. Variant creation and ordinary-product creation reject codes that collide with an existing variant.

Variant names include the parent plus option names/values, for example `T-Shirt — Color: Black / Size: Small`. The existing cart and committed `snapshot_name`, `snapshot_sku` and `snapshot_price_cents` fields preserve this display without reading the current catalog. Receipts, history details and product reports therefore retain the selected options. No historical order data or receipt schema is rewritten.

### Draft lifecycle

1. Create a parent in Products → Products with variants.
2. Create a draft with opening stock. Drafts are inactive and omitted from terminal snapshots.
3. Edit/remove the draft, or activate it for sale.
4. Once activated, it can be edited or deactivated, but never reset to draft or deleted. A disconnected terminal may already hold an unsynced sale. This restriction is enforced in both the API and database.

Opening stock uses the existing movement-backed creation transaction. There is no inventory counting or stock-adjustment interface. The manager editor labels its quantity **Server stock**; register stock includes local sale adjustments.

### Sync and security

- Owner/manager authorization is checked against current membership on every management request.
- Parent/product references are store-scoped, including database composite foreign keys and SKU uniqueness.
- The parent table has RLS and member-only reads; browser roles cannot write it directly.
- All variant mutations first lock the existing store feed row. Product/parent changes, opening stock and feed positions commit together. Draft removal publishes a tombstone.
- The existing consistent catalog snapshot carries `parent_product_id`, `parent_name`, `option_values`, and `is_draft` on product records. This application currently refreshes catalog through that full snapshot, not a new incremental-pull endpoint.
- Dexie version 6 adds the store/parent index. Catalog replacement, scoped checkpoint update, stock replacement and retirement of acknowledged local adjustments happen atomically. Other stores' adjustments are retained.
- Cashier access and offline authorization are unchanged. Deactivation is effective on offline terminals after their next successful catalog refresh; an offline browser cannot know about a change it has not downloaded. Old paid sales remain uploadable after deactivation.
- Updates require the last-read revision. Concurrent manager edits return a conflict instead of silently overwriting each other.

## Deployment

Apply `supabase/migrations/202609220001_product_variants.sql` after the existing migrations, **before deploying the updated API**. Then deploy API and web together. The migration is additive; existing non-variant records remain unchanged. It has been executed and tested on embedded PostgreSQL (PGlite), including existing-product compatibility. This branch does not apply it to the shared live Supabase project.

The clean test database skips the pre-existing `202609180006_stores_country_column.sql` deployment-repair migration because the checked-in earlier business-details migration already creates that column. Neither historical migration is modified here.

## API

Documented in `api/openapi.yaml`:

- `GET /catalog/product-parents?store_id=…`: manager list with variants and stock.
- `POST /catalog/product-parents`: create a parent.
- `PATCH /catalog/product-parents/:id`: rename with revision; current child names/revisions and feed entries update atomically.
- `POST /catalog/variants`: create inactive draft; one to four option pairs, independent SKU/barcode/price/opening stock.
- `PATCH /catalog/variants/:id`: edit/activate/deactivate with revision. No stock edits or parent reassignment.
- `DELETE /catalog/variants/:id`: remove only never-published, unsold draft with revision.

Existing catalog snapshot and order push routes are retained. No sale, payment, refund or printing endpoint is added. No route/layout changes are needed: entry points are the existing Products and register screens.

## Manual acceptance steps

Use a test store and ensure the new migration is applied to its API database.

1. In Products, use the existing **Add product** action to create an ordinary product. Sell it normally and check its receipt.
2. In **Products with variants**, create parent `T-Shirt`.
3. Create draft `TS-S-B`: Size Small, Color Black, barcode `991001`, price 12.00, opening stock 7.
4. Create draft `TS-L-W`: Size Large, Color White, barcode `991002`, price 15.00, opening stock 9.
5. Confirm drafts are not sellable. Edit one draft and save. Create a spare draft, remove it, and confirm it disappears. Activate both real variants.
6. Refresh the terminal catalog online. In Sell, choose T-Shirt. Check the options, prices, SKUs and separate stock quantities. Choose Small/Black, then complete payment.
7. Scan `991002` using an HID keyboard scanner, or type it into register search and press Enter. Confirm only Large/White reaches the cart; complete payment.
8. Check stock independently: Small/Black 6, Large/White 8, once their sales sync. Local terminals include pending sale deductions in projected stock.
9. After the production app shell and catalog are cached, disconnect. Reload the register and sell a variant. Refresh its receipt URL, open Orders and reprint. Reconnect and verify the sale uploads.
10. Edit a variant's options, SKU and price and rename its parent. Reopen old receipts/history and the local product report: original option details, SKU and amounts remain unchanged.
11. Deactivate a variant, refresh the terminal catalog, and scan its code. It must not enter the cart. Checkout also rejects a cached cart item once its local catalog record becomes inactive or draft.
12. Confirm a published variant has no remove action. An API deletion attempt must fail even before the server sees any sale, protecting unsynced offline transactions.
13. Try duplicate SKU/barcode/option combinations, invalid price/stock, another store's parent ID, and stale revisions. Verify useful errors with no partial writes.
14. Check at 375, 390, 768 and 1440 px. Tab through the picker, use Escape, verify focus returns to its parent card, and reopen it with Enter.

## Automated validation

```powershell
cd apps/web
npm test
npm run build
cd ../api
npm run build
npm run test:orders
npm run test:integration
node --import tsx test/variants-browser-check.ts
```

The browser check applies the real migrations, runs the real API against embedded PostgreSQL, creates products through the UI/API, provisions and unlocks a real test terminal session, sells via checkout, uploads to the API, and verifies central stock and immutable order items. Only the Supabase identity boundary is a test fixture. It includes offline reload/sale, manager authorization, RLS, cross-store references, draft deletion/publication guard, optimistic revision conflicts and responsive screenshots.

The browser runner builds with test configuration. Run the normal web build afterward to restore the developer's configured build.

Final validation results:

- Web unit tests: 23 passed.
- API order/report tests: 14 passed.
- API integration tests: 17 passed.
- API and web production builds: passed.
- Product-variant browser workflow: passed at 375, 390, 768 and 1440 px.

Test environment: Windows, Node 24.18.1, Playwright Chromium 153.0.8010.12. HID input is simulated as keyboard input ending in Enter; no physical scanner is attached. Existing receipt printing is reused, without changes to printing behavior.

See [screenshots](screenshots/) for the manager editor, variant picker, historical receipt and product report.
