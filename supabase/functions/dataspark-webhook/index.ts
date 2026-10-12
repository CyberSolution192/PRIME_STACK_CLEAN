/**
 * dataspark-webhook  Supabase Edge Function
 *
 * Receives Dataspark's signed order notifications (order.completed / order.failed / ping)
 * and moves the matching order out of "processing" within seconds, instead of waiting for
 * the 10-minute reconcile-stale-orders job (which stays in place as the safety net).
 *
 * SECURITY
 *   - Called by Dataspark's servers, not browsers: no CORS headers, POST only.
 *   - Every message is authenticated with HMAC-SHA256 over `${t}.${rawBody}` using the
 *     signing secret DATASPARK_WEBHOOK_SECRET (whsec_..., a Supabase secret). Compared in
 *     constant time. Messages older than 5 minutes are rejected (replay protection).
 *   - Fails CLOSED: if the secret is not configured, every request is refused.
 *   - The body is size-capped, and only orders that were placed through Dataspark
 *     (external_response.provider = 'dataspark') can be touched. The phone number in the
 *     message must match our order before any status change is made.
 *   - It never writes to the DB tables directly: status changes go through
 *     admin-manage-orders (update-status), the single owner of all status side effects,
 *     exactly like reconcile-stale-orders does.
 *   - Idempotent: duplicates / retries / out-of-order deliveries are harmless, because the
 *     decision is based on the order's CURRENT status, not on arrival order.
 *
 * DEPLOY (must be public so Dataspark can reach it; the signature is the authentication):
 *   supabase functions deploy dataspark-webhook --no-verify-jwt
 *   supabase secrets set DATASPARK_WEBHOOK_SECRET=whsec_...
 *   Webhook URL to enter in the Dataspark dashboard:
 *     https://<project-ref>.supabase.co/functions/v1/dataspark-webhook
 *
 * REQUIRED ENV (already used by reconcile-stale-orders):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_INTERNAL_SECRET, SYSTEM_ADMIN_USER_ID
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { raiseAlert } from "../_shared/admin-alerts.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_SKEW_SECONDS = 300; // reject messages older/newer than 5 minutes

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ─── Signature check ─────────────────────────────────────────────────────────
function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(header: string, rawBody: string, secret: string): Promise<boolean> {
  const parts: Record<string, string> = {};
  for (const p of header.split(",")) {
    const i = p.indexOf("=");
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || typeof v1 !== "string" || v1.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - t) > MAX_SKEW_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${rawBody}`));
  return timingSafeEqual(toHex(sig), v1.toLowerCase());
}

// ─── Status change via admin-manage-orders (single owner of side effects) ────
async function syncStatus(orderId: string, newStatus: "completed" | "failed"): Promise<boolean> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const INTERNAL     = Deno.env.get("ADMIN_INTERNAL_SECRET");
  const ADMIN_ID     = Deno.env.get("SYSTEM_ADMIN_USER_ID");
  if (!INTERNAL || !ADMIN_ID) {
    console.error("[dataspark-webhook] ADMIN_INTERNAL_SECRET / SYSTEM_ADMIN_USER_ID not configured");
    return false;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-manage-orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "x-internal-secret": INTERNAL,
        "x-admin-user-id": ADMIN_ID,
        "x-admin-role": "admin",
      },
      body: JSON.stringify({ action: "update-status", orderId, status: newStatus }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.success !== false;
  } catch (err) {
    console.error("[dataspark-webhook] syncStatus error:", err);
    return false;
  }
}

// Which current statuses may move to which new status. Anything else is left alone
// (or raised as an alert) so the webhook can never silently overwrite an admin decision.
const CAN_COMPLETE = new Set(["processing", "manual_review", "failed_provider", "pending"]);
const CAN_FAIL     = new Set(["processing", "manual_review", "pending"]);

serve(async (req) => {
  if (req.method !== "POST") return reply(405, { ok: false, message: "Method not allowed" });

  const secret = Deno.env.get("DATASPARK_WEBHOOK_SECRET");
  if (!secret) {
    console.error("[dataspark-webhook] DATASPARK_WEBHOOK_SECRET not configured  refusing all requests");
    return reply(503, { ok: false, message: "Not configured" });
  }

  // Size guard (header first, then actual length)
  const declared = parseInt(req.headers.get("content-length") || "0", 10);
  if (declared > MAX_BODY_BYTES) return reply(413, { ok: false, message: "Payload too large" });

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return reply(413, { ok: false, message: "Payload too large" });

  // Authenticate BEFORE parsing or acting on anything
  const sigHeader = req.headers.get("X-Dataspark-Signature") || "";
  if (!(await verifySignature(sigHeader, rawBody, secret))) {
    console.warn("[dataspark-webhook] rejected: bad or stale signature");
    return reply(400, { ok: false, message: "Invalid signature" });
  }

  let event: any;
  try { event = JSON.parse(rawBody); } catch { return reply(400, { ok: false, message: "Invalid JSON" }); }

  const type: string = String(event?.event || "");
  const deliveryId = req.headers.get("X-Dataspark-Delivery") || event?.id || "unknown";

  if (type === "ping") {
    console.log(`[dataspark-webhook] ping received (${deliveryId})`);
    return reply(200, { ok: true, message: "pong" });
  }
  if (type !== "order.completed" && type !== "order.failed") {
    // Unknown event types are acknowledged so Dataspark does not retry them.
    return reply(200, { ok: true, ignored: true });
  }

  const data = event?.data || {};
  const reference = String(data.client_reference || "");
  const dsOrderId = String(data.id || "");
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(reference)) return reply(200, { ok: true, ignored: "bad reference" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const COLS = "id, order_reference, status, recipient, external_response";

  // Which of OUR orders is this? The reference we send differs by flow:
  //   buy-data / api-order  -> our own order_reference
  //   store / guest (paystack-webhook) -> a generated id that is NOT stored as order_reference
  // but EVERY accepted order stores Dataspark's own order id in provider_response, so match
  // on that first (works for all flows), then fall back to order_reference.
  let order: any = null;
  if (/^[A-Za-z0-9-]{8,64}$/.test(dsOrderId)) {
    const byId = await supabase
      .from("adminorders").select(COLS)
      .filter("external_response->provider_response->>_dataspark_order_id", "eq", dsOrderId)
      .limit(1).maybeSingle();
    if (byId.error) { console.error("[dataspark-webhook] lookup error:", byId.error.message); return reply(500, { ok: false }); }
    order = byId.data;
  }
  if (!order) {
    const byRef = await supabase
      .from("adminorders").select(COLS)
      .eq("order_reference", reference)
      .maybeSingle();
    if (byRef.error) { console.error("[dataspark-webhook] lookup error:", byRef.error.message); return reply(500, { ok: false }); }
    // order_reference alone is not proof it went through Dataspark: require the provider tag
    if (byRef.data && byRef.data.external_response?.provider === "dataspark") order = byRef.data;
  }

  if (!order) {
    // Signed by Dataspark, but we cannot tie it to an order (e.g. an unconfirmed placement that
    // was parked in Manual Review). Acknowledge (no retry storm) but make a human look.
    console.warn(`[dataspark-webhook] unmatched ${type} for ${reference} / ${dsOrderId} (${deliveryId})`);
    await raiseAlert(supabase, {
      type: "dataspark_unmatched_order",
      severity: "MEDIUM",
      message: `Dataspark reported ${data.status || type} for reference ${reference}, but no matching order was found. If a customer order is in Manual Review, check it against this reference.`,
      details: { reference, dataspark_order_id: dsOrderId, status: data.status, phone: data.phone, delivery: deliveryId },
    });
    return reply(200, { ok: true, ignored: "unmatched order" });
  }

  // Sanity check: the message must describe OUR order (same recipient)
  const msgPhone = String(data.phone || "").replace(/\D/g, "").replace(/^233/, "0");
  const ourPhone = String(order.recipient || "").replace(/\D/g, "").replace(/^233/, "0");
  if (msgPhone && ourPhone && msgPhone !== ourPhone) {
    await raiseAlert(supabase, {
      type: "dataspark_webhook_mismatch",
      severity: "HIGH",
      message: `Dataspark webhook for ${reference} has a different phone number than our order. No change made.`,
      details: { order_id: order.id, reference, delivery: deliveryId },
    });
    return reply(200, { ok: true, ignored: "mismatch" });
  }

  const target: "completed" | "failed" = type === "order.completed" ? "completed" : "failed";

  // Already in the target state, or an admin already moved it elsewhere: nothing to do.
  if (order.status === target) return reply(200, { ok: true, noop: "already " + target });

  const allowed = target === "completed" ? CAN_COMPLETE : CAN_FAIL;
  if (!allowed.has(order.status)) {
    // e.g. order already refunded/failed but provider now says completed (or vice-versa)
    await raiseAlert(supabase, {
      type: "dataspark_status_conflict",
      severity: "HIGH",
      message: `Dataspark reports ${reference} as ${target}, but our order is "${order.status}". Review manually (check for double refund / undelivered data).`,
      details: { order_id: order.id, reference, our_status: order.status, provider_status: target, refunded_at_provider: !!data.refunded },
    });
    return reply(200, { ok: true, conflict: true });
  }

  const ok = await syncStatus(order.id, target);
  if (!ok) return reply(500, { ok: false, message: "Status sync failed" }); // Dataspark will retry

  if (target === "failed") {
    // A failed order needs a human decision about refunding the customer.
    await raiseAlert(supabase, {
      type: "order_failed_at_provider",
      severity: "HIGH",
      message: `Order ${reference} FAILED at Dataspark${data.refunded ? " (Dataspark refunded our wallet)" : " (not refunded at Dataspark)"}. Refund the customer from All Orders if appropriate.`,
      details: { order_id: order.id, reference, provider: "dataspark", provider_refunded: !!data.refunded },
    });
  }

  console.log(`[dataspark-webhook] ${reference} -> ${target} (${deliveryId})`);
  return reply(200, { ok: true });
});
