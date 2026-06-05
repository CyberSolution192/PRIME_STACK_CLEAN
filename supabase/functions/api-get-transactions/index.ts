/**
 * api-get-transactions — Supabase Edge Function
 *
 * Public API endpoint — called directly by resellers (NOT via user-proxy).
 * Auth: X-API-Key header
 * Method: POST
 * Rate limit: 60 requests per minute
 *
 * Returns the reseller's API order history with pagination.
 * Only returns orders placed via this API (api_orders table) — not
 * dashboard purchases or other transaction types.
 *
 * Request body (all optional):
 *   {
 *     "limit":  10,   // records per page, max 50, default 10
 *     "offset": 0     // pagination offset, default 0
 *   }
 *
 * Success response (200):
 *   {
 *     "status": true,
 *     "statusCode": 200,
 *     "message": "Transactions retrieved successfully",
 *     "payload": {
 *       "transactions": [
 *         {
 *           "order_reference": "API-M9K2D4-IJ78KL",
 *           "network": "mtn",
 *           "phone": "0241234567",
 *           "size": 5,
 *           "amount": 22.50,
 *           "status": "processing",
 *           "created_at": "2026-05-09T10:05:00Z"
 *         }
 *       ],
 *       "count": 1,
 *       "total": 25,
 *       "limit": 10,
 *       "offset": 0
 *     }
 *   }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateApiKey, checkRateLimit } from "../_shared/api-auth.ts";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "x-api-key, content-type, apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const RATE_LIMIT = 60;
const MAX_LIMIT  = 50;
const DEF_LIMIT  = 10;

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

  // ── 3. Parse pagination params ────────────────────────────────────────────
  let limit  = DEF_LIMIT;
  let offset = 0;

  try {
    const body = await req.json();
    if (body?.limit !== undefined) {
      const parsed = parseInt(String(body.limit), 10);
      if (!isNaN(parsed) && parsed > 0) limit = Math.min(parsed, MAX_LIMIT);
    }
    if (body?.offset !== undefined) {
      const parsed = parseInt(String(body.offset), 10);
      if (!isNaN(parsed) && parsed >= 0) offset = parsed;
    }
  } catch {
    // No body — use defaults
  }

  // ── 4. Fetch transactions from api_orders ─────────────────────────────────
  // Only returns this reseller's own orders (user_id enforced server-side)
  const { data: transactions, count, error } = await supabase
    .from("api_orders")
    .select(
      "order_reference, network, phone, size, amount, status, manual_fallback, created_at",
      { count: "exact" }
    )
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("[api-get-transactions] fetch error:", error.message);
    return json({ status: false, statusCode: 500, message: "Failed to retrieve transactions" }, 500);
  }

  const result = (transactions ?? []).map((t: any) => ({
    order_reference: t.order_reference,
    network:         t.network,
    phone:           t.phone,
    size:            t.size,
    amount:          parseFloat(t.amount),
    currency:        "GHS",
    status:          t.status,
    created_at:      t.created_at,
  }));

  console.log(`[api-get-transactions] Returned ${result.length} of ${count ?? 0} for user ${auth.userId}`);

  return json({
    status: true,
    statusCode: 200,
    message: "Transactions retrieved successfully",
    payload: {
      transactions: result,
      count:        result.length,
      total:        count ?? 0,
      limit,
      offset,
    },
  });
});