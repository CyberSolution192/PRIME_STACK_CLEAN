# Prime Connect — Security Fix Package
## Everything you need to harden your app

---

## What's in this package

```
📁 edge-functions/
   ├── get-user-data/index.ts          — replaces all direct frontend DB reads
   ├── submit-withdrawal/index.ts      — replaces direct withdrawal_requests insert
   ├── save-store-settings/index.ts    — replaces direct stores upsert
   ├── save-store-prices/index.ts      — replaces direct store_bundle_prices upsert
   ├── track-order/index.ts            — replaces unauthenticated adminorders read
   ├── admin-manage-bundles/index.ts   — replaces direct bundle CRUD
   ├── admin-manage-orders/index.ts    — replaces direct order updates + manual creation
   ├── admin-manage-users/index.ts     — replaces direct user table reads/writes
   └── admin-manage-withdrawals/index.ts — replaces direct withdrawal status updates
📄 security_hardening_migration.sql   — tightens RLS + adds audit log table
📄 SECURITY_AUDIT_REPORT.md           — full findings with proof-of-concept exploits
📄 FRONTEND_MIGRATION_GUIDE.md        — exact before/after code changes for every fix
📄 README.md                          — this file
```

---

## Deployment Steps

### Step 1 — Run the SQL migration
```bash
# Via Supabase CLI:
supabase db push security_hardening_migration.sql

# Or paste into Supabase Dashboard → SQL Editor → Run
```

### Step 2 — Deploy the edge functions
```bash
# From your project root, for each function:
supabase functions deploy get-user-data
supabase functions deploy submit-withdrawal
supabase functions deploy save-store-settings
supabase functions deploy save-store-prices
supabase functions deploy track-order
supabase functions deploy admin-manage-bundles
supabase functions deploy admin-manage-orders
supabase functions deploy admin-manage-users
supabase functions deploy admin-manage-withdrawals
```

### Step 3 — Update the frontend HTML files
Follow `FRONTEND_MIGRATION_GUIDE.md` for the exact find-and-replace changes needed in:
- `dashboard.html` (5 changes)
- `store.html` (1 change)
- `admin.html` (7 changes + XSS fixes)
- `login.html` (remove duplicate anon key)
- `signup.html` (remove duplicate anon key)

---

## Vulnerabilities Fixed

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | 🔴 CRITICAL | Direct DB access from frontend | 9 new edge functions |
| 2 | 🔴 CRITICAL | Admin bypass via browser console | Server-side role check in all admin edge functions |
| 3 | 🔴 CRITICAL | Withdrawal amount not server-validated | `submit-withdrawal` reads balance from DB |
| 4 | 🔴 CRITICAL | XSS via `err.message` in innerHTML | Wrap all dynamic content in `esc()` |
| 5 | 🟠 HIGH | Anon key duplicated in 3 files | Import from `supabase-config.js` only |
| 6 | 🟠 HIGH | CSP `unsafe-inline` defeats XSS policy | Move inline scripts to external .js files |
| 7 | 🟠 HIGH | Unauthenticated `adminorders` read | `track-order` edge function, safe fields only |
| 8 | 🟠 HIGH | No server-side audit log | `admin_audit_log` table + all admin functions write to it |
| 9 | 🟡 MEDIUM | onclick handlers with DB record IDs | `data-*` attributes + `addEventListener` |
| 10 | 🟡 MEDIUM | `getSession()` instead of `getUser()` | Use `getUser()` for auth gate |

---

## Architecture After Fixes

```
Browser (HTML/JS)
       │
       │  JWT Bearer token on every request
       ▼
Supabase Edge Functions  ◄── Service Role Key (secret, server only)
       │                          │
       │ verifies JWT             │ reads/writes DB directly
       │ enforces role            │ writes audit log
       │ validates inputs         │
       ▼                          ▼
  Returns only safe          Supabase Database
  fields to browser            (RLS = backstop)
```

**The browser never gets a DB connection. It only ever gets back what the edge function decides to send.**

---

## Notes

- The existing `verify-paystack`, `guest-buy-data`, `set-announcement`, `get-announcement`, and `send-sms` edge functions are **already well-written** — they all verify JWT + role server-side. No changes needed there.
- The `admin_audit_log` table will start capturing all admin actions once the new edge functions are deployed.
- After deploying, check Supabase Dashboard → Edge Functions → Logs to confirm each function is healthy.
- The SQL migration uses `DROP POLICY IF EXISTS` before creating new ones, so it's safe to re-run.
