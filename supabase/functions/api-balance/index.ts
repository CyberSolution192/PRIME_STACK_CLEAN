/**
 * api-balance — Supabase Edge Function
 *
 * Public API endpoint — called directly by resellers (NOT via user-proxy).
 * Auth: X-API-Key header
 * Method: POST (Supabase Edge Functions work best with POST)
 * Rate limit: 60 requests per minute
 *
 * Returns the reseller's current wallet balance.
 *
 * Response:
 *   {
 *     status: true,
 *     statusCode: 200,
 *     message: "Balance retrieved successfully",
 *     payload: {
 *       balance: 178.50,
 *       currency: "GHS"
 *     }
 *   }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateApiKey, checkRateLimit } from "../_shared/api-auth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
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

  // ── 3. Fetch wallet ───────────────────────────────────────────────────────
  const { data: wallet, error: walletError } = await supabase
    .from("wallets")
    .select("balance, is_frozen")
    .eq("user_id", auth.userId)
    .single();

  if (walletError || !wallet) {
    console.error("[api-balance] Wallet not found for user:", auth.userId, walletError?.message);
    return json({ status: false, statusCode: 404, message: "Wallet not found" }, 404);
  }

  return json({
    status: true,
    statusCode: 200,
    message: "Balance retrieved successfully",
    payload: {
      balance:  parseFloat(wallet.balance),
      currency: "GHS",
    },
  });
});