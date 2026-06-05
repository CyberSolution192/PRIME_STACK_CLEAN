/**
 * api-get-bundles — Supabase Edge Function
 *
 * Public API endpoint — called directly by resellers (NOT via user-proxy).
 * Auth: X-API-Key header
 * Method: POST
 * Rate limit: 60 requests per minute
 *
 * Returns all active data bundles available for ordering.
 * The price field reflects the amount that will be charged to your wallet.
 *
 * Request body (all optional):
 *   { "network": "mtn" }   // filter by network: mtn | telecel | airteltigo
 *
 * Success response (200):
 *   {
 *     "status": true,
 *     "statusCode": 200,
 *     "message": "Bundles retrieved successfully",
 *     "payload": {
 *       "bundles": [
 *         {
 *           "id": "uuid",
 *           "network": "mtn",
 *           "size": 5,
 *           "price": 22.50,
 *           "currency": "GHS"
 *         }
 *       ],
 *       "count": 1
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

  // ── 3. Parse optional body ────────────────────────────────────────────────
  let networkFilter: string | null = null;
  try {
    const body = await req.json();
    if (body?.network && typeof body.network === "string") {
      const n = body.network.toLowerCase().trim();
      const valid = ["mtn", "telecel", "airteltigo"];
      if (!valid.includes(n)) {
        return json({
          status: false,
          statusCode: 400,
          message: "Invalid network filter. Must be one of: mtn, telecel, airteltigo",
        }, 400);
      }
      networkFilter = n;
    }
  } catch {
    // No body is fine — all bundles will be returned
  }

  // ── 4. Fetch active bundles ───────────────────────────────────────────────
  let bundleQuery = supabase
    .from("bundles")
    .select("id, network, size, price")
    .eq("active", true)
    .order("network", { ascending: true })
    .order("size",    { ascending: true });

  if (networkFilter) {
    bundleQuery = bundleQuery.eq("network", networkFilter);
  }

  const { data: bundles, error: bundleError } = await bundleQuery;

  if (bundleError) {
    console.error("[api-get-bundles] bundle fetch error:", bundleError.message);
    return json({ status: false, statusCode: 500, message: "Failed to retrieve bundles" }, 500);
  }

  if (!bundles || bundles.length === 0) {
    return json({
      status: true,
      statusCode: 200,
      message: "Bundles retrieved successfully",
      payload: { bundles: [], count: 0 },
    });
  }

  // ── 5. Fetch reseller's custom prices for these bundles ───────────────────
  const bundleIds = bundles.map((b: any) => b.id);

  const { data: customPrices } = await supabase
    .from("user_bundle_prices")
    .select("bundle_id, custom_price")
    .eq("user_id", auth.userId)
    .in("bundle_id", bundleIds);

  // Build a lookup map: bundle_id → custom_price
  const customPriceMap: Record<string, number> = {};
  if (customPrices) {
    for (const cp of customPrices) {
      const parsed = parseFloat(cp.custom_price);
      if (!isNaN(parsed) && parsed > 0) {
        customPriceMap[cp.bundle_id] = parsed;
      }
    }
  }

  // ── 6. Build response — apply custom prices ───────────────────────────────
  const result = bundles.map((b: any) => {
    const hasCustom = b.id in customPriceMap;
    return {
      id:      b.id,
      network: b.network,
      size:    b.size,
      price:   hasCustom ? customPriceMap[b.id] : parseFloat(b.price),
      currency: "GHS",
    };
  });

  console.log(`[api-get-bundles] Returned ${result.length} bundles for user ${auth.userId}${networkFilter ? ` (network: ${networkFilter})` : ""}`);

  return json({
    status: true,
    statusCode: 200,
    message: "Bundles retrieved successfully",
    payload: {
      bundles: result,
      count:   result.length,
    },
  });
});