# Stress-test findings: fix plan

## Context

The user found two real bugs in the customer screen: (1) clicking "Search online" with an empty box silently browsed every customer instead of showing a validation error, and (2) a duplicate-phone error message named the *other* customer ("...already saved for Jane Doe"), leaking their name. Both were already fixed (`apps/web/src/screens/CustomerScreen.tsx`, `apps/web/src/lib/customer-local.ts`).

The user then asked for the whole app to be stress-tested for the same two bug categories — **Category A**: an action proceeding silently instead of validating input first; **Category B**: an error/message disclosing another person's/record's info the requester shouldn't see. Three parallel audits covered every screen (`apps/web/src/screens/*.tsx`, `apps/web/src/terminal-auth/*.tsx`), every backend route (`apps/api/src/routes/*.ts`, `apps/api/src/terminal-auth/routes.ts`), and the checkout/payment/sync/exchange flow specifically (highest financial stakes).

**Result**: no other instance of Category A or Category B was found in customer-facing screens or the general API surface — the two original bugs were isolated. But the checkout-flow-specific audit found real, separate issues below, unrelated to the original two bugs but valid problems in their own right.

## Fixes to make, in priority order

### 1. (High) No stock-limit validation when adding to cart

- **Files**: `apps/web/src/screens/RegisterScreen.tsx` (`addProductToCart`, ~line 189-195, and the catalog card `onClick` ~line 266-271), `apps/web/src/lib/pos-store.ts` (`addItem`/`incrementItem`, ~line 123-148 — currently only caps at a hardcoded `Math.min(10_000, ...)`), `apps/web/src/lib/checkout.ts` (`completeLocalSale`, ~line 26-70 — validates `product.active`/`is_draft`/store match but never compares `item.quantity` against on-hand stock).
- **Problem**: `RegisterScreen` already computes and *displays* per-product stock (`stock[product.id] ?? 0`) but never uses it to gate adding/incrementing. A cashier can add far more than what's on hand, checkout succeeds, and a negative `stock_adjustments.delta` gets written silently — an unwarned oversell.
- **Fix approach**: block `addProductToCart`/the `+` control once the cart quantity for that product would exceed `stock[product.id]` (mirroring how `RegisterScreen`'s existing `proceedBlocked` gate disables checkout for an empty/invalid cart) — show an inline message ("Only N left in stock") rather than silently refusing. Decide whether to hard-block or just warn-and-allow (a store might legitimately want to oversell for a backorder) — **ask the user which behavior they want before implementing**, since this changes real sales behavior, not just UX polish.
- **Also check**: whether `completeLocalSale` should keep a server-side/DB-level backstop regardless of the UI fix (defense in depth, matching how `pos_refund_items_enforce_quantity` is a DB trigger *and* the API pre-validates) — the existing "oversold products" server report already reflects this after the fact, but nothing currently blocks it at write time.

### 2. (Medium-High) Exchange screen missing double-submit guard

- **File**: `apps/web/src/screens/ExchangeScreen.tsx` — `submit` (~line 168-181) and `submitTerminal` (~line 186-199).
- **Problem**: both only guard with `if (!canSubmit || !receipt) return`, where `canSubmit` is closed over from the last render (includes `!busy`). `apps/web/src/screens/PaymentScreen.tsx` (~line 12, 39-56) already solved this exact problem with a `useRef` (`inProgress`) since React state doesn't update synchronously between two fast clicks. `ExchangeScreen` never got the same fix, so two fast clicks can fire `completeLocalExchange`/`completeLocalTerminalExchange` twice — each does its own refund + new-sale order server-side, with no shared idempotency key across the two independently-generated `exchangeOperationId`s.
- **Fix approach**: copy `PaymentScreen`'s `inProgress` ref pattern into `ExchangeScreen`'s `submit`/`submitTerminal`, exactly as already proven there. This is a direct, low-risk port of an existing correct pattern — no design decision needed.

### 3. (Medium) Terminal PIN snapshot over-shares — needs a decision, not just a patch

- **File**: `apps/api/src/terminal-auth/routes.ts`, `snapshot()` ~line 108-116.
- **Problem**: every terminal device in a store receives *every* active employee's name, role, and PBKDF2 PIN hash+salt (for offline PIN verification) — not scoped to only the employees who actually use that specific terminal. If a terminal's cached snapshot were ever extracted, an attacker gets every employee's (including managers'/owners') PIN material, not just local users'.
- **This is an architecture tradeoff** (offline-first PIN verification needs *some* local credential cache), not a simple bug — **ask the user how they want to scope this** before changing anything: options include (a) leave as-is (accepted risk, offline verification requires it), (b) only ship verifier material for employees who've actually logged into that specific terminal at least once (narrows blast radius but adds first-login-must-be-online complexity), (c) increase PBKDF2 iteration count / add periodic rotation as a mitigation instead of scoping. Do not implement any of these without the user picking a direction.

### 4. (Medium) Raw server error text shown to cashiers unfiltered

- **File**: `apps/web/src/lib/order-sync-core.ts`, ~line 128-131.
- **Problem**: `body.message` from the API response is written directly into `orders.failure_reason`/`outbox.failure_reason` with no allowlist/rewriting — only falls back to a generic message when the server sends none. Whenever the server *does* send a message, whatever raw string it produced goes straight to the cashier-facing sync-status UI unfiltered — same category of bug as the name leak, just with backend-generated text instead of another person's name.
- **Fix approach**: audit what messages `apps/api` actually sends on 400/409/422 responses for sale pushes (`ApiError` messages in `apps/api/src/routes/orders.ts`) — if they're all already written to be cashier-appropriate plain language (likely, given the rest of the API's error messages are careful), this may just need a comment/test confirming that invariant rather than a code change. If any raw/internal-sounding message is found, translate it or genericize it at the point of display instead of trusting server text unconditionally.

### 5. (Low-Medium) Cart-total error silently overwritten by cash-amount error

- **File**: `apps/web/src/screens/PaymentScreen.tsx`, ~line 30-35.
- **Problem**: if `totals()` throws (corrupted cart/discount data) *and* the cashier has typed something in the cash field, the second `catch` unconditionally overwrites `amountError` — only the last error is ever shown, which may not be the actionable one.
- **Fix approach**: keep both errors distinct (e.g. two separate state variables, or concatenate/prioritize the cart error first since it's more fundamental) rather than one shared `amountError` variable that the second check can clobber.

### 6. (Low-Medium) "Rejected" label conflates permanent validation failures with recoverable auth-expiry

- **File**: `apps/web/src/lib/order-sync-core.ts`, ~line 11-29 (`classifySyncState`, `SYNC_STATE_LABELS`, `canRetrySync`).
- **Problem**: an `authentication` failure (expired token — just needs the cashier to sign back in) is classified into the same `'rejected'` state and shown the same `"Rejected — needs review"` label as a genuine permanent `validation` rejection, even though `canRetrySync` already treats them differently internally. Confusing for non-technical cashier staff.
- **Fix approach**: give `authentication` its own `SyncState`/label (e.g. `"Sign in again to sync"`) distinct from `'rejected'`, and update whichever screen renders `SYNC_STATE_LABELS` (not yet located in this pass — find it first) to handle the new state.

### Follow-ups — not yet confirmed as real bugs, quick verification needed before deciding to fix

- **`apps/api/src/routes/variants.ts` ~line 77, 93**: forwards a raw `(error as Error).message` from `packages/domain/src/variants.ts`'s `variantName`/`variantOptions` validators straight to the client. Likely fine (call sites only ever pass the caller's own submitted values into those functions), but not fully verified in this pass — read `packages/domain/src/variants.ts` and confirm its thrown messages never echo back anything other than the caller's own input.
- **`apps/api/src/terminal-auth/routes.ts` `/auth/login`**: not fully traced for a wrong-PIN-vs-employee-doesn't-exist enumeration oracle (different status/message revealing whether an employee/device exists). Trace every branch of the login path and confirm both cases return indistinguishable responses, or fix if they don't.

## Suggested execution order

1. Fix #2 (Exchange double-submit) first — smallest, safest, directly copies an already-proven pattern.
2. Fix #5 and #6 — both small, localized, no design decisions needed.
3. Verify the two follow-ups (variants.ts, /auth/login) — quick reads, decide if they need fixes.
4. Fix #4 after auditing what messages the API actually sends — may turn out to need no code change.
5. Discuss #1 (stock-limit behavior: hard-block vs. warn-and-allow) and #3 (PIN snapshot scoping) with the user before touching either — both are product/security decisions, not pure bug fixes.

## Verification

- Run `apps/api/npm run test:integration` and `apps/web/npx tsc -b --noEmit` after each fix.
- For the Exchange double-submit fix specifically: manually reproduce a fast double-click in the dev preview before and after the fix if possible, since this is a timing-dependent bug that a type-check won't catch.
- For the stock-limit fix: decide the exact UX (block vs. warn) with the user first, then test by setting a product's stock low and attempting to oversell it in the Register screen.
