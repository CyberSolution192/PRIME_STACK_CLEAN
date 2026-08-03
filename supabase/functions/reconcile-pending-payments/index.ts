/**
 * reconcile-pending-payments — Supabase Edge Function
 *
 * Independently double-checks adminorders stuck at status='payment_pending'
 * against Paystack's own transaction-verify API, instead of relying solely
 * on the webhook having fired/succeeded.
 *
 * payment_pending orders are intentionally hidden from the admin order list
 * (most are simply abandoned checkouts) — this job exists to catch the rare,
 * dangerous case where a customer WAS charged but nothing was ever fulfilled
 * (e.g. the webhook never arrived at all, or arrived and crashed before the
 * paystack-webhook crash-handling fix).
 *
 * Two outcomes per stale order, decided by asking Paystack directly:
 *   - NOT successful (abandoned/failed/reversed) -> mark 'failed'. Quietly
 *     closes out a genuinely abandoned checkout, and stops it from showing
 *     as a permanent fake "Pending" on the store owner's dashboard.
 *   - SUCCESSFUL -> mark 'failed_provider' (the same status buy-data already
 *     uses for "payment ok, provider fulfillment failed" — this makes it
 *     show up automatically in the existing admin dashboard's manual-pending
 *     bucket) and raise a CRITICAL admin_alert (SMS), since real money was
 *     collected and nothing was delivered.
 *
 * Never marks anything 'completed' automatically — a successful payment does
 * not mean data was delivered; that always needs a human to actually place
 * the order (or explicitly decide how to handle it).
 *
 * Auth: service-role bearer only (same pattern as refresh-stat).
 *
 * REQUIRED CONFIG (ADMIN_INTERNAL_SECRET / SYSTEM_ADMIN_USER_ID already set
 * from reconcile-stale-orders; PAYSTACK_SECRET_KEY already set for
 * verify-paystack / paystack-webhook):
 *   ADMIN_INTERNAL_SECRET, SYSTEM_ADMIN_USER_ID, PAYSTACK_SECRET_KEY
 *
 * Deploy:
 *   supabase functions deploy reconcile-pending-payments --no-verify-jwt
 *
 * Schedule (run in SQL editor once, after deploying):
 *   NOTE: pg_net's default request timeout is only 5 seconds, which is too
 *   short for this function to reliably finish a full batch (it makes one
 *   Paystack API call per stale order, sequentially). Always pass an explicit
 *   timeout_milliseconds as shown below.
 *   select cron.schedule(
 *     'reconcile-pending-payments',
 *     '0,15,30,45 * * * *',  -- every 15 minutes
 *     $$select net.http_post(
 *       url := '<YOUR_SUPABASE_URL>/functions/v1/reconcile-pending-payments',
 *       headers := jsonb_build_object(
 *         'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
 *         'Content-Type', 'application/json'
 *       ),
 *       timeout_milliseconds := 30000
 *     )$$
 *   );
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { raiseAlert } from "../_shared/admin-alerts.ts";
import { verifyPaystackTransaction } from "../_shared/paystack-verify.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const STALE_MINUTES = 15; // long enough that a real checkout should have resolved one way or another
const BATCH_SIZE     = 10;  // smaller batch so a full run comfortably finishes within pg_net's request timeout
const SLEEP_MS        = 200; // be polite to Paystack's API between calls, without dragging the whole batch out

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const PAYSTACK_SECRET  = Deno.env.get("PAYSTACK_SECRET_KEY");
  const INTERNAL_SECRET  = Deno.env.get("ADMIN_INTERNAL_SECRET");
  const SYSTEM_ADMIN_ID  = Deno.env.get("SYSTEM_ADMIN_USER_ID");

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ success: false, message: "Server configuration error" }, 500);
  }

  // ── Auth: only pg_cron / trusted service callers ──────────────────────────
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token || token !== SERVICE_KEY) {
    return json({ success: false, message: "Unauthorized" }, 401);
  }

  if (!PAYSTACK_SECRET) return json({ success: false, message: "PAYSTACK_SECRET_KEY not configured" }, 500);
  if (!INTERNAL_SECRET) return json({ success: false, message: "ADMIN_INTERNAL_SECRET not configured" }, 500);
  if (!SYSTEM_ADMIN_ID) return json({ success: false, message: "SYSTEM_ADMIN_USER_ID not configured" }, 500);

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const staleCutoff = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();

  // ── Find stale payment_pending orders ─────────────────────────────────────
  const { data: pendingOrders, error: fetchError } = await supabase
    .from("adminorders")
    .select("id, order_reference, payment_reference, amount, recipient, network, package_size, created_at")
    .eq("status", "payment_pending")
    .lt("created_at", staleCutoff)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchError) {
    console.error("[reconcile-pending-payments] Fetch error:", fetchError.message);
    return json({ success: false, message: "Failed to fetch pending orders" }, 500);
  }

  if (!pendingOrders || pendingOrders.length === 0) {
    return json({ success: true, checked: 0, closedAbandoned: 0, flaggedPaid: 0, skipped: 0, message: "Nothing stale" });
  }

  let checked = 0;
  let closedAbandoned = 0;
  let flaggedPaid = 0;
  let skipped = 0;

  for (const order of pendingOrders) {
    checked++;
    const reference = order.payment_reference || order.order_reference;

    if (!reference) {
      console.warn(`[reconcile-pending-payments] ${order.order_reference} has no payment_reference — skipping`);
      skipped++;
      continue;
    }

    const verification = await verifyPaystackTransaction(reference, PAYSTACK_SECRET);

    if (!verification.ok) {
      // Couldn't get a clean answer from Paystack this run — don't guess,
      // just try again next cycle rather than risk a wrong call.
      console.warn(`[reconcile-pending-payments] SKIP ${order.order_reference} (ref=${reference}) — HTTP ${verification.httpStatus}, message: "${verification.message}"`);
      skipped++;
      await sleep(SLEEP_MS);
      continue;
    }

    if (verification.status === "success") {
      // Money was collected but this order never got fulfilled — the
      // dangerous case. Use the same status buy-data already uses for
      // "payment ok, provider failed" so it surfaces in the existing
      // admin dashboard's manual-pending bucket automatically.
      const synced = await syncStatus(SUPABASE_URL, SERVICE_KEY, INTERNAL_SECRET, SYSTEM_ADMIN_ID, order.id, "failed_provider");
      if (synced) {
        flaggedPaid++;
        const amount = Math.abs(parseFloat(String(order.amount)) || 0);
        await raiseAlert(supabase, {
          type: "payment_stuck_unfulfilled",
          severity: "CRITICAL",
          message: `Order ${order.order_reference} (GH₵${amount.toFixed(2)}, ${order.recipient}) was paid on Paystack but never fulfilled — no successful webhook was ever recorded. Marked failed_provider for manual handling.`,
          details: {
            order_id: order.id,
            order_reference: order.order_reference,
            payment_reference: reference,
            amount,
            recipient: order.recipient,
            network: order.network,
            package_size: order.package_size,
            paystack_status: verification.status,
          },
        });
        console.log(`[reconcile-pending-payments] ${order.order_reference} — PAID, flagged failed_provider`);
      } else {
        console.error(`[reconcile-pending-payments] ${order.order_reference} — failed to sync status to failed_provider`);
      }
    } else {
      // Genuinely abandoned/failed/reversed — safe to quietly close out.
      const synced = await syncStatus(SUPABASE_URL, SERVICE_KEY, INTERNAL_SECRET, SYSTEM_ADMIN_ID, order.id, "failed");
      if (synced) {
        closedAbandoned++;
        // Best-effort: also close the mirrored guest_orders row (read directly
        // by track-guest-order.ts for non-store guest customers checking by
        // phone), so it doesn't sit at 'payment_pending' there forever either.
        await supabase
          .from("guest_orders")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("payment_reference", reference)
          .then(({ error: e }) => { if (e) console.warn(`[reconcile-pending-payments] guest_orders sync warn:`, e.message); });
      } else {
        console.error(`[reconcile-pending-payments] ${order.order_reference} — failed to sync status to failed`);
      }
    }

    await sleep(SLEEP_MS);
  }

  console.log(`[reconcile-pending-payments] Checked ${checked}, closed ${closedAbandoned} abandoned, flagged ${flaggedPaid} paid-unfulfilled, skipped ${skipped}`);

  // ── Backlog health check ───────────────────────────────────────────────────
  // This batch only processed up to BATCH_SIZE rows. If the total backlog is
  // still large after that, checkout volume may be outpacing this job's
  // capacity — surface it now instead of letting it silently regrow into
  // another months-long blind spot like the one this job was built to fix.
  const { count: remainingBacklog } = await supabase
    .from("adminorders")
    .select("id", { count: "exact", head: true })
    .eq("status", "payment_pending")
    .lt("created_at", staleCutoff);

  const BACKLOG_ALERT_THRESHOLD = 50;
  if ((remainingBacklog || 0) > BACKLOG_ALERT_THRESHOLD) {
    await raiseAlert(supabase, {
      type: "payment_reconciliation_backlog",
      severity: "MEDIUM",
      message: `${remainingBacklog} orders are still stuck in payment_pending after this run — the reconciliation job may be falling behind checkout volume. Consider raising BATCH_SIZE or running it more frequently.`,
      details: { remainingBacklog, batchSize: BATCH_SIZE, staleMinutes: STALE_MINUTES },
    });
  }

  return json({ success: true, checked, closedAbandoned, flaggedPaid, skipped, remainingBacklog: remainingBacklog || 0 });
});

// ── Route the status change through admin-manage-orders ─────────────────────
// Same reasoning as reconcile-stale-orders: reuse its audit-log + sync logic
// instead of writing to adminorders directly from here.
async function syncStatus(
  supabaseUrl: string,
  serviceKey: string,
  internalSecret: string,
  systemAdminId: string,
  orderId: string,
  newStatus: string
): Promise<boolean> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/admin-manage-orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
        "x-internal-secret": internalSecret,
        "x-admin-user-id": systemAdminId,
        "x-admin-role": "admin",
      },
      body: JSON.stringify({ action: "update-status", orderId, status: newStatus }),
    });
    const data = await res.json();
    return res.ok && data.success !== false;
  } catch (err) {
    console.error("[reconcile-pending-payments] syncStatus error:", err);
    return false;
  }
}