/**
 * api-order-status — Supabase Edge Function
 *
 * Public API endpoint — called directly by resellers (NOT via user-proxy).
 * Auth: X-API-Key header
 * Method: POST
 * Rate limit: 60 requests per minute
 *
 * Returns the status of a specific order placed via the API.
 * Resellers can ONLY query orders that belong to their own API key.
 *
 * Request body:
 *   { "order_reference": "API-m9k2d4-ij78kl" }
 *
 * Success response (200):
 *   {
 *     status: true,
 *     statusCode: 200,
 *     payload: {
 *       order_reference: "API-m9k2d4-ij78kl",
 *       network: "mtn",
 *       size: 5,
 *       phone: "0241234567",
 *       amount: 22.00,
 *       status: "processing",
 *       created_at: "2026-05-09T10:05:00Z"
 *     }
 *   }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateApiKey, checkRateLimit } from "../_shared/api-auth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "x-api-key, content-type, apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const RATE_LIMIT = 60; // requests per minute

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── 1. Validate API key ───────────────────────────────────────────────────
  const auth = await validateApiKey(req, supabase);
  if (!auth.valid) {
    return json({ status: false, statusCode: auth.status, message: auth.message }, auth.status);
  }

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const rate = await checkRateLimit(supabase, auth.keyId, RATE_LIMIT);
  if (!rate.allowed) {
    return json({
      status: false,
      statusCode: 429,
      message: `Rate limit exceeded. Retry after ${rate.retryAfter} seconds.`,
      retry_after_seconds: rate.retryAfter,
    }, 429);
  }

  // ── 3. Parse body ─────────────────────────────────────────────────────────
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ status: false, statusCode: 400, message: "Invalid JSON body" }, 400);
  }

  const orderRef = (body.order_reference as string | undefined)?.trim();
  if (!orderRef) {
    return json({ status: false, statusCode: 400, message: "Missing required field: order_reference" }, 400);
  }

  // Enforce API- prefix — this endpoint only serves API-originated orders
  if (!orderRef.startsWith("API-")) {
    return json({ status: false, statusCode: 404, message: "Order not found" }, 404);
  }

  // ── 4. Look up order — MUST belong to this reseller ──────────────────────
  // user_id check prevents resellers from querying each other's orders
  const { data: order, error: orderError } = await supabase
    .from("api_orders")
    .select("order_reference, network, size, phone, amount, status, manual_fallback, created_at")
    .eq("order_reference", orderRef)
    .eq("user_id", auth.userId)   // ← security: ownership enforced server-side
    .maybeSingle();

  if (orderError) {
    console.error("[api-order-status] DB error:", orderError.message);
    return json({ status: false, statusCode: 500, message: "Failed to retrieve order" }, 500);
  }

  if (!order) {
    return json({ status: false, statusCode: 404, message: "Order not found" }, 404);
  }

  return json({
    status:     true,
    statusCode: 200,
    payload: {
      order_reference: order.order_reference,
      network:         order.network,
      size:            order.size,
      phone:           order.phone,
      amount:          parseFloat(order.amount),
      status:          order.status,
      created_at:      order.created_at,
    },
  });
});