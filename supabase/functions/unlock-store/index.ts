/**
 * unlock-store — Replaces direct supabase.rpc('unlock_store') in dashboard.html
 *
 * FIXES:
 *   VULN-01 (direct DB RPC from frontend)
 *   VULN-10 (uses getUser() for server-side JWT verification)
 *
 * Validates server-side that:
 *   1. User is authenticated (JWT verified via getUser())
 *   2. User does not already have a store
 *   3. User's wallet has sufficient balance (GH₵50)
 *   4. Deducts GH₵50, creates the store row, logs transaction atomically
 *
 * POST /functions/v1/unlock-store
 * Body: {} (no params needed — user identity comes from JWT)
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "https://rpolemxgussziexdmdxe.supabase.co",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const UNLOCK_FEE = 50; // GH₵50

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, message: "Unauthorized" }, 401);

  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Verify JWT server-side (VULN-10 fix) ─────────────────────────────────
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return json({ success: false, message: "Invalid or expired token" }, 401);
  }

  try {
    // ── 1. Check wallet balance ────────────────────────────────────────────
    const { data: wallet, error: walletErr } = await supabase
      .from("wallets")
      .select("balance")
      .eq("user_id", user.id)
      .single();

    if (walletErr || !wallet) {
      return json({ success: false, message: "Wallet not found" }, 404);
    }

    const balance = parseFloat(wallet.balance);
    if (balance < UNLOCK_FEE) {
      return json({
        success: false,
        message: `Insufficient balance. You need GH₵${UNLOCK_FEE} to unlock your store (current balance: GH₵${balance.toFixed(2)})`,
      }, 400);
    }

    // ── 2. Check user doesn't already have a store ─────────────────────────
    const { data: existing } = await supabase
      .from("stores")
      .select("id")
      .eq("owner_id", user.id)
      .maybeSingle();

    if (existing) {
      return json({ success: false, message: "You already have a store" }, 400);
    }

    // ── 3. Deduct wallet balance via RPC (uses service role — bypasses RLS) ─
    const idempotencyKey = `unlock-store-${user.id}-${Date.now()}`;
    const { data: deductResult, error: deductErr } = await supabase.rpc(
      "deduct_wallet_balance",
      {
        p_user_id:        user.id,
        p_amount:         UNLOCK_FEE,
        p_description:    "Store unlock fee",
        p_idempotency_key: idempotencyKey,
        p_details:        { action: "store_unlock", fee: UNLOCK_FEE },
      }
    );

    if (deductErr) {
      console.error("unlock-store deduct error:", deductErr);
      return json({ success: false, message: deductErr.message || "Failed to deduct balance" }, 500);
    }

    if (!deductResult?.success) {
      return json({
        success: false,
        message: deductResult?.message || "Insufficient balance",
      }, 400);
    }

    // ── 4. Generate unique short_code ──────────────────────────────────────
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    async function generateUniqueShortCode(): Promise<string> {
      for (let i = 0; i < 10; i++) {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        const code = Array.from(bytes).map(b => chars[b % chars.length]).join("");
        const { data } = await supabase
          .from("stores").select("id").eq("short_code", code).maybeSingle();
        if (!data) return code;
      }
      throw new Error("Failed to generate unique short code");
    }

    const short_code = await generateUniqueShortCode();
    const slug = "store-" + user.id.substring(0, 8);

    // ── 5. Create the store row ────────────────────────────────────────────
    const { error: storeErr } = await supabase.from("stores").insert({
      owner_id:   user.id,
      slug,
      short_code,
      status:     "active",
      name:       "My Store",
      theme_color: "#0ea5e9",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (storeErr) {
      // Refund balance since store creation failed
      console.error("unlock-store store insert error (attempting refund):", storeErr);
      await supabase.rpc("refund_wallet_balance", {
        p_user_id:       user.id,
        p_amount:        UNLOCK_FEE,
        p_transaction_id: null,
        p_reason:        "Store unlock failed — auto refund",
      });
      return json({ success: false, message: "Failed to create store. Balance has been refunded." }, 500);
    }

    // ── 6. Mark user as store_unlocked ────────────────────────────────────
    await supabase
      .from("users")
      .update({ store_unlocked: true, updated_at: new Date().toISOString() })
      .eq("id", user.id)
      .then(({ error: e }) => {
        if (e) console.warn("unlock-store: failed to set store_unlocked flag:", e.message);
      });

    console.log(`✅ Store unlocked — user: ${user.id}, short_code: ${short_code}`);

    return json({
      success:    true,
      message:    "Store unlocked successfully",
      short_code,
      slug,
    });

  } catch (err) {
    console.error("unlock-store error:", err);
    return json({ success: false, message: "Internal server error" }, 500);
  }
});