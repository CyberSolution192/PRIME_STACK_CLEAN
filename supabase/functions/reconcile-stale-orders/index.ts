/**
 * reconcile-stale-orders — Supabase Edge Function
 *
 * Finds orders stuck in status='processing' for longer than STALE_MINUTES and
 * tries to resolve their real status, then syncs the result back through
 * admin-manage-orders (action=update-status) so all the existing multi-table
 * sync logic there (transactions, guest_orders, api_orders, store totals) runs
 * exactly as it would for a manual admin change.
 *
 * Per-provider behavior:
 *   - up2u: checked via Up2u's GET /order/:order_id — real status resolution.
 *   - bundlezonegh: Bundle Zone GH's API has NO documented order-status or
 *     order-lookup-by-reference endpoint (only place_order, check_balance,
 *     get_bundles, get_transactions — none of which reliably identify a
 *     single order by our reference). Rather than guess-matching against
 *     get_transactions (risking a wrong status write on a financial record),
 *     bundlezonegh orders skip live verification entirely and go straight
 *     through the same escalate-after-ESCALATE_MINUTES safety net used when
 *     an up2u order has no stored provider reference. If Bundle Zone GH later
 *     documents a real order-status endpoint, wire it in here the same way
 *     Up2u's is wired in below.
 *
 * This function does NOT write to adminorders/transactions directly — it always
 * routes through admin-manage-orders, acting as a "system" admin, so there's
 * exactly one place that owns status-transition side effects.
 *
 * Escalation: orders unresolved past ESCALATE_MINUTES get flagged into
 * admin_alerts for manual review, even if the provider's API can't explain why.
 *
 * Auth: service-role bearer only (same pattern as refresh-stat).
 *
 * REQUIRED CONFIG:
 *   SYSTEM_ADMIN_USER_ID — a real admin user's UUID from your admins/profiles
 *   table. Used as the actor for audit-log entries when this job changes an
 *   order's status. Must be a valid FK value for admin_audit_log.admin_id.
 */

// Deploy:
//   supabase functions deploy reconcile-stale-orders --no-verify-jwt
//
// Schedule (run in SQL editor once, after deploying):
//   select cron.schedule(
//     'reconcile-up2u-stale-orders',
//     '*/10 * * * *',  -- every 10 minutes
//     $$select net.http_post(
//       url := '<YOUR_SUPABASE_URL>/functions/v1/reconcile-stale-orders',
//       headers := jsonb_build_object(
//         'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
//         'Content-Type', 'application/json'
//       )
//     )$$
//   );

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { raiseAlert } from "../_shared/admin-alerts.ts";

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

const STALE_MINUTES    = 10;  // eligible for a status re-check
const ESCALATE_MINUTES = 120; // still unresolved after this long -> flag for a human
const BATCH_SIZE       = 20;  // per run, to stay well under Up2u's rate limit
const SLEEP_MS         = 350; // small delay between provider calls in a batch

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const UP2U_API_KEY      = Deno.env.get("UP2U_API_KEY");
  const INTERNAL_SECRET   = Deno.env.get("ADMIN_INTERNAL_SECRET");
  const SYSTEM_ADMIN_ID   = Deno.env.get("SYSTEM_ADMIN_USER_ID");

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ success: false, message: "Server configuration error" }, 500);
  }

  // ── Auth: only pg_cron / trusted service callers ──────────────────────────
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token || token !== SERVICE_KEY) {
    return json({ success: false, message: "Unauthorized" }, 401);
  }

  if (!INTERNAL_SECRET) return json({ success: false, message: "ADMIN_INTERNAL_SECRET not configured" }, 500);
  if (!SYSTEM_ADMIN_ID) return json({ success: false, message: "SYSTEM_ADMIN_USER_ID not configured" }, 500);
  // UP2U_API_KEY is only required if there turn out to be stale up2u orders in
  // this batch — checked per-order below, so a missing key doesn't block
  // bundlezonegh (or future providers) from being escalated.

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const staleCutoff = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
  const escalateCutoff = new Date(Date.now() - ESCALATE_MINUTES * 60_000).toISOString();

  // ── Find stale orders still stuck in 'processing' for any reconcilable provider ──
  const { data: staleOrders, error: fetchError } = await supabase
    .from("adminorders")
    .select("id, order_reference, status, updated_at, external_response")
    .eq("status", "processing")
    .filter("external_response->>provider", "in", "(up2u,bundlezonegh)")
    .lt("updated_at", staleCutoff)
    .order("updated_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchError) {
    console.error("[reconcile-stale-orders] Fetch error:", fetchError.message);
    return json({ success: false, message: "Failed to fetch stale orders" }, 500);
  }

  if (!staleOrders || staleOrders.length === 0) {
    return json({ success: true, checked: 0, updated: 0, escalated: 0, message: "No stale orders" });
  }

  let checked = 0;
  let updated = 0;
  let escalated = 0;

  for (const order of staleOrders) {
    checked++;
    const provider: string = order.external_response?.provider || "unknown";
    const isPastEscalation = order.updated_at < escalateCutoff;

    // ── Bundle Zone GH: no order-status endpoint exists, so there's nothing to
    // poll. Skip straight to the same time-based escalation safety net used
    // for up2u orders with no stored reference. ────────────────────────────
    if (provider === "bundlezonegh") {
      if (isPastEscalation) {
        await escalate(supabase, order, "Order stuck in processing — Bundle Zone GH has no order-status API to auto-verify against; needs manual review.", provider);
        escalated++;
      }
      continue;
    }

    if (!UP2U_API_KEY) {
      console.warn(`[reconcile-stale-orders] ${order.order_reference} — UP2U_API_KEY not configured, cannot check`);
      if (isPastEscalation) {
        await escalate(supabase, order, "Order stuck in processing — Up2u API key not configured, cannot auto-reconcile.", provider);
        escalated++;
      }
      continue;
    }

    const reference = order.external_response?._up2u_reference;

    if (!reference) {
      console.warn(`[reconcile-stale-orders] ${order.order_reference} has no _up2u_reference — cannot check`);
      if (isPastEscalation) {
        await escalate(supabase, order, "Order stuck in processing with no provider reference stored — cannot auto-reconcile.", provider);
        escalated++;
      }
      continue;
    }

    try {
      const res = await fetch(
        `https://fmulclzwaohrzznsgalg.supabase.co/functions/v1/public-api/order/${encodeURIComponent(reference)}`,
        { method: "GET", headers: { "X-API-Key": UP2U_API_KEY } }
      );

      if (!res.ok) {
        console.warn(`[reconcile-stale-orders] ${order.order_reference} — Up2u HTTP ${res.status}`);
        if (isPastEscalation) {
          await escalate(supabase, order, `Up2u order lookup failed repeatedly (HTTP ${res.status}) past ${ESCALATE_MINUTES} minutes.`, provider);
          escalated++;
        }
        await sleep(SLEEP_MS);
        continue;
      }

      const data = await res.json();
      const deliveryStatus: string = data.order?.delivery_status || data.order?.status || "";

      let newStatus: string | null = null;
      if (deliveryStatus === "completed") newStatus = "completed";
      else if (deliveryStatus === "failed") newStatus = "failed";
      // "pending" / "cached" / "processing" -> leave as-is, check again next run

      if (newStatus) {
        const synced = await syncStatus(SUPABASE_URL, INTERNAL_SECRET, SYSTEM_ADMIN_ID, order.id, newStatus);
        if (synced) {
          updated++;
          console.log(`[reconcile-stale-orders] ${order.order_reference} -> ${newStatus}`);
        } else {
          console.error(`[reconcile-stale-orders] ${order.order_reference} — failed to sync status via admin-manage-orders`);
        }
      } else if (isPastEscalation) {
        await escalate(supabase, order, `Up2u still reports "${deliveryStatus || "unknown"}" after ${ESCALATE_MINUTES} minutes.`, provider);
        escalated++;
      }
    } catch (err) {
      console.error(`[reconcile-stale-orders] ${order.order_reference} — error:`, err);
      if (isPastEscalation) {
        await escalate(supabase, order, `Reconciliation check threw an error: ${err instanceof Error ? err.message : "unknown"}`, provider);
        escalated++;
      }
    }

    await sleep(SLEEP_MS);
  }

  console.log(`[reconcile-stale-orders] Checked ${checked}, updated ${updated}, escalated ${escalated}`);
  return json({ success: true, checked, updated, escalated });
});

// ── Route the status change through admin-manage-orders ─────────────────────
// Reuses its existing transactions/guest_orders/api_orders sync logic instead
// of duplicating it here. Acts as a "system" admin via the same internal-secret
// header check admin-proxy uses.
async function syncStatus(
  supabaseUrl: string,
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
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "x-internal-secret": internalSecret,
        "x-admin-user-id": systemAdminId,
        "x-admin-role": "admin",
      },
      body: JSON.stringify({ action: "update-status", orderId, status: newStatus }),
    });
    const data = await res.json();
    return res.ok && data.success !== false;
  } catch (err) {
    console.error("[reconcile-stale-orders] syncStatus error:", err);
    return false;
  }
}

// ── Flag an order for manual admin attention ─────────────────────────────────
async function escalate(supabase: any, order: any, message: string, provider: string) {
  await raiseAlert(supabase, {
    type: "order_escalated",
    severity: "HIGH",
    message: `Order ${order.order_reference}: ${message}`,
    details: {
      order_id: order.id,
      order_reference: order.order_reference,
      provider,
      stuck_since: order.updated_at,
    },
  });
}