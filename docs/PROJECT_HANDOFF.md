# Counterline project handoff

Last updated: 2026-09-15

## Project purpose

Counterline is an offline-first retail POS. Owners and managers use email authentication to administer a store. Cashiers use a provisioned browser terminal and a PIN to access the POS.

## Current repository state

- Current shared branch: `develop`.
- The local checkout is on `develop` and tracks `origin/develop`.
- Direct work on `main` or `develop` is not allowed. Use a focused feature branch and a pull request.
- Read `docs/rules.md` before starting work.
- Keep commits focused and meaningful; do not combine unrelated work in one commit.

## Completed work

### Owner, manager, and store access

- Owner/manager email signup, sign-in, password reset, email confirmation, store creation, invitations, and store memberships exist.
- Do not rework these flows without an explicitly scoped task.
- Settings has an owner/manager store-team invitation form.

### Terminal provisioning and cashier PIN access

- Browser terminals are provisioned by owners/managers.
- Every terminal has an identity and unique receipt prefix.
- Cashiers use `/pos/login`, select an employee, and enter a 4–8 digit PIN.
- Terminal access uses HttpOnly cookies and dedicated terminal device-session records.
- Refresh-token rotation has lost-response recovery.
- Reprovisioning a browser revokes the browser’s prior terminal, including when moving between stores.
- PIN failures lock device and employee access after repeated failed attempts.
- Offline cashier access caches only terminal employee/PIN-verifier data in Dexie and expires after the documented authorization window.
- Manager terminal and cashier employee setup screens are under Settings.

### Catalog, checkout, and synchronization

- Catalog is cached in Dexie by store.
- Checkout saves order, order items, payment, stock adjustments, and outbox entry atomically before sync starts.
- Monetary values use integer cents; do not introduce floating-point money calculations.
- Order synchronization is idempotent and has retry/failure handling.
- Owner routes remain available:
  - `GET /api/catalog/snapshot`
  - `POST /api/orders/push`
- Cashier terminal routes were added:
  - `GET /api/pos/catalog/snapshot?store_id=<uuid>`
  - `POST /api/pos/orders/push`
- Terminal routes require valid terminal-access and cashier-session cookies and reject a payload for another store.
- Cashier flow is:
  1. `/pos/login`
  2. `/pos/register`
  3. `/pos/payment`
  4. sale saved locally, then synchronized when possible.

### Settings and UI

- Settings overview has POS setup cards, terminal summary, invitation form, and an active store-team list.
- The Settings overview remains two columns through desktop/tablet widths and stacks only on narrow mobile widths.
- The cashier register uses its own POS shell and does not use owner navigation or owner sign-out behavior.
- The cashier POS shell uses Counterline’s existing dark green sidebar color.
- Register category filters are present as a compact `Browse` row below product search.
- Payment has cash/card selection, quick tender buttons, local-save notice, and checkout summary.

## Migrations

Never edit a migration that has been applied to Supabase. Add a new timestamped migration instead.

Already used terminal migrations:

1. `supabase/migrations/202609150001_terminal_employee_access.sql`
2. `supabase/migrations/202609150002_terminal_device_sessions.sql`

Catalog and checkout migration to run before using catalog/checkout in an environment:

3. `supabase/migrations/202609150001_catalog_checkout_sync.sql`

Settings team-name visibility migration to run after the base auth/store migration:

4. `supabase/migrations/202609150003_team_profile_visibility.sql`

The team-profile migration allows people who share a store to see each other’s profile names. It does not expose profiles outside shared stores.

## Local development

### Required environment files

Do not commit real secrets. Put local credentials only in ignored environment files.

`apps/api/.env` needs the project database URL, Supabase URL, publishable key, web origin, and any required CA-certificate path.

`apps/web/.env.local` needs:

```env
VITE_SUPABASE_URL=<Supabase project URL>
VITE_SUPABASE_PUBLISHABLE_KEY=<Supabase publishable key>
VITE_API_URL=/api
```

Use `/api` locally. Vite proxies it to port 3001 so API calls and terminal cookies remain on the same browser origin.

### Start locally in PowerShell

If `npm` is unavailable, first run:

```powershell
$env:Path = "C:\Program Files\nodejs;$env:Path"
```

API:

```powershell
cd D:\pos\counterline-pos\apps\api
npm run dev
```

Web:

```powershell
cd D:\pos\counterline-pos\apps\web
npm run dev
```

Local URLs:

- Web app: `http://127.0.0.1:5173`
- API health: `http://127.0.0.1:3001/health`
- Cashier login: `http://127.0.0.1:5173/pos/login`
- Cashier register: `http://127.0.0.1:5173/pos/register`
- Settings: `http://127.0.0.1:5173/settings`

If port 3001 is occupied, find and stop the owning process before starting another API process.

## Validation completed

The integration work was validated with:

```powershell
cd apps/api
npm run build
npm test
npm run test:orders

cd ..\web
npm run build
```

Results at handoff:

- API TypeScript build passed.
- Terminal security tests: 3 passed.
- Order-validation tests: 5 passed.
- Web production build passed.
- Vite reports a pre-existing main-bundle-size warning; it does not fail the build.

## Pull request history

- PR #5: terminal UI integration — merged into `develop`.
- PR #7: cashier register, checkout, catalog/order sync integration, Settings team list, and UI refinements — merged into `develop`.
- PR #6: terminal hardware and storage settings — review separately before merging. It includes scanner testing, browser-storage status, and a test receipt. Its PR description notes a stale pre-existing browser-test selector; run its documented verification before merge.
- Do not merge the older offline POS foundation PR #2.
- Hamza’s original catalog/checkout branch was based on an older `develop`; its work was integrated through PR #7 instead of merging that stale branch directly.

## Known constraints and next work

- Customer Creation and Lookup (`FEAT-CRM-01`) is a planned feature, not yet implemented. It should include normalized-phone search, optional order-to-customer relation, atomic local customer/outbox creation, dedicated API sync, and dependency ordering that blocks an order upload until its referenced customer is accepted.
- Hardware work in PR #6 should remain isolated from checkout and terminal-auth changes.
- Friday is reserved for production migration execution, environment configuration, smoke tests, and deployment. Avoid starting large new features immediately before deployment.

## Manual browser test flow

1. Sign in as an owner or manager.
2. Open Settings and provision a terminal.
3. Create an active cashier employee with a PIN.
4. Visit `/pos/login`, select the cashier, and unlock the terminal.
5. Open register, verify catalog download, select a category/product, and add it to the sale.
6. Complete a cash or confirmed external-card payment.
7. Confirm the receipt prefix belongs to the provisioned terminal and the order is saved locally.
8. Restore connectivity if needed and confirm the outbox synchronizes the order.
9. In Settings, confirm existing active owner/manager team members are listed after the team-profile migration has run.

