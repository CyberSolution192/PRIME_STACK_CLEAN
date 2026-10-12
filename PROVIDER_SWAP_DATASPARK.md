# Provider swap: Pensite GH -> Dataspark

Pensite GH is removed from the code. Dataspark takes its slot in the admin **Data Provider** switch.
Admin still chooses the active provider manually; nothing switches automatically.

## What changed

| Area | Change |
|---|---|
| `_shared/dataspark.ts` (new) | The only place that calls Dataspark. Holds the key handling, bundle lookup, idempotent ordering and timeout recovery. |
| `buy-data`, `api-order`, `guest-buy-data`, `paystack-webhook` | Pensite code, mapper and `'pensite'` case removed. `'dataspark'` added to the provider type and dispatcher. Everything else in those files is byte-for-byte unchanged. |
| `admin-manage-orders` | `active_provider` allow-list: `pensite` -> `dataspark`. This is the server-side gate for the admin switch. |
| `zprx.html`, `zprx.js` | Pensite card and label replaced by a Dataspark card and label. Still 7 providers. Switching still goes through the `admin-manage-orders` Edge Function. |
| `dataspark-webhook` (new) | Receives signed order results, moves orders out of "processing" in seconds. |
| `reconcile-stale-orders` | Also resolves stuck Dataspark orders (looks up by our own order reference). Safety net if a webhook is missed. |
| `sync-bundle-costs` | Also syncs Dataspark prices so margin alerts cover it. |
| `deploy/sql/10_retire_pensite_provider.sql` | Resets the DB setting if it still says `pensite`. Does not touch any order data. |

## How Dataspark orders work here

- Dataspark buys by `bundle_id`. We look up the bundle for (network, size) from `GET /bundles` (a 30-day bundle is preferred if several share a size).
- **Idempotent ordering.** Dataspark's `client_reference` is our order id (`TXN-...` / `API-...`) for wallet and API orders. Store and guest orders keep using the id that `paystack-webhook` already generates for every provider (`JD...`). A retry with the same reference can never charge twice.
- **Matching results back to orders.** Every accepted order saves Dataspark's own order id (and the reference we sent) in `external_response.provider_response`. The webhook matches on that id, so it works for all flows. If a signed result cannot be matched to any order, a MEDIUM alert is raised.
- Orders are asynchronous: they are stored as `processing`, then become `completed` or `failed` through the webhook (fast) or the reconcile job (backup).
- If a request times out, the code checks Dataspark by reference before doing anything else. If it cannot tell whether the order was placed, it does **not** guess and does **not** use auto-fallback (that could deliver the data twice). The order goes to **Manual Review** (not the refundable `failed_provider` status) with the reference to verify in the Dataspark dashboard. A low Dataspark wallet also lands in Manual Review.
- A Dataspark order that ends `failed` raises a HIGH alert. Refunding the customer stays a manual admin action (All Orders -> order -> Refund), the same as for every other provider.

## Security

- The API key is only a Supabase secret (`DATASPARK_API_KEY`). It is read inside Edge Functions, never logged, never returned, never stored in the database, never present in frontend code.
- All Dataspark calls happen in Edge Functions. The admin page never calls a provider or the database directly.
- The webhook is the only new public endpoint. It fails closed without its secret, verifies an HMAC-SHA256 signature in constant time, rejects messages older than 5 minutes, caps body size, ignores orders that were not placed through Dataspark, checks the phone number matches, and only changes status through `admin-manage-orders`.
- Dataspark's optional **IP allowlist** is not used here, because Supabase Edge Functions do not have a fixed outbound IP.
- Use a dedicated Dataspark key for this platform and set a sensible daily spending limit on it in the Dataspark dashboard.

## Deploy order (this order avoids any gap)

1. **Secrets** (type them on your own computer, never in chat):
   ```
   supabase secrets set DATASPARK_API_KEY=dc_live_...
   supabase secrets set DATASPARK_WEBHOOK_SECRET=whsec_...
   ```
   (Get the `whsec_` value in step 3 first if you prefer; the webhook just refuses requests until it exists.)
2. **Deploy functions:** `powershell -ExecutionPolicy Bypass -File deploy\deploy-functions.ps1`
   This deploys the 4 order functions, `admin-manage-orders`, `dataspark-webhook`, `reconcile-stale-orders` and `sync-bundle-costs`, plus the rest of your normal list.
3. **Dataspark dashboard -> Developer API -> Webhooks:** URL `https://<project-ref>.supabase.co/functions/v1/dataspark-webhook`, save, copy the `whsec_` secret into step 1, then **Send test event**. You should see `pong` in the function logs.
4. **Upload the new `zprx.html` and `zprx.js`** (admin portal).
5. **Admin portal -> Settings -> Data Provider:** if the banner still shows Pensite, switch to any provider you trust. Then run `deploy/sql/10_retire_pensite_provider.sql` in the SQL editor.
6. **Smoke test:** switch to **Dataspark**, place the smallest bundle to a number you control. Expect `processing`, then `completed` within about a minute (via the webhook). Check `GET /balance` on the Dataspark side dropped by the bundle price.
7. **Cleanup:** `supabase secrets unset PENSITE_API_KEY`. Leave a provider you trust active.
8. Run `sync-bundle-costs` once (or wait for its schedule) so Dataspark prices appear in cost tracking.

## Rollback

Admin portal -> Data Provider -> switch to any other provider (instant). The Dataspark code is inert whenever it is not the active provider, and no data was changed.

## Things to know

- **Old Pensite orders stay in your history.** Their stored `provider` value remains `pensite`. That is data, not code, and deleting or relabelling it would alter financial records. The SQL file includes a read-only query listing any Pensite order still stuck in `processing` (these are not auto-reconciled, same as before).
- **Wallet:** Dataspark pays from its own wallet balance. Keep it topped up; a low balance produces a Manual Review order with an `insufficient_balance` message.
- **Bundle sizes:** if you sell a size Dataspark does not list for that network, the order fails cleanly into Manual Review (nothing is charged at Dataspark).
