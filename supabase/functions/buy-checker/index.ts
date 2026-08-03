// buy-checker — Purchase a results checker (BECE/WASSCE/SHS Placement)
//
// Flow (mirrors buy-data's wallet-debit + provider-call pattern):
//   1. Verify JWT, load the product + resolve the customer's price
//   2. Debit wallet (optimistic lock via wallets.version) BEFORE calling
//      DataBossHub, same as buy-data — the transaction/order row exists
//      first so a crash mid-flow is always recoverable/auditable.
//   3. Call DataBossHub live: GET /checker/slots?category=X to find an
//      available slot, then POST /checker/buy/{id} to actually purchase it.
//      No local stock is held — this happens once, at the moment the
//      customer pays, per your instruction.
//   4. On success: store serial/pin/exam info on checker_orders, return it.
//      On failure before any DataBossHub charge (no slot found, or the
//      slots call itself errors): auto-refund the customer's wallet.
//      On failure AFTER a buy/{id} call was attempted (ambiguous — may or
//      may not have been charged on the DataBossHub side): do NOT
//      auto-refund; flag manual_review for an admin to reconcile, exactly
//      like buy-data does for ambiguous provider failures.
//
// SECURITY: price always comes from our DB (checker_products /
// user_checker_prices), never from the request body. category/dbh_category
// mapping is admin-configured, not inferred from user input.
//
// POST body: { code: "bece" | "wassce" | "shs_placement", index_number?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function generateOrderId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `CHK-${timestamp}-${random}`.toUpperCase();
}

const DBH_BASE = "https://bbhubportal.com/api/v1";

function dbhHeaders(apiKey: string) {
  return {
    "X-API-KEY": apiKey,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
}

// ── Find an available slot for this category ────────────────────────────────
// TODO before go-live: log one real response from this endpoint and confirm
// the field names below (slots array location + id field) match exactly.
// DataBossHub's other endpoints use a { status: "success", data: ... }
// envelope, so that's assumed here too.
async function findAvailableSlot(
  apiKey: string,
  dbhCategory: string
): Promise<{ success: true; slotId: string } | { success: false; error: string }> {
  try {
    const url = `${DBH_BASE}/checker/slots?category=${encodeURIComponent(dbhCategory)}`;
    const res = await fetch(url, { method: "GET", headers: dbhHeaders(apiKey) });

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `DataBossHub slots HTTP ${res.status}: ${text}` };
    }

    const data = await res.json();

    if (data.status !== "success" && data.status !== true) {
      return { success: false, error: `DataBossHub slots error: ${data.message || "Unknown error"}` };
    }

    // CONFIRMED shape (verified against a real response, 2026-07-31):
    // { "status": "success", "data": { "items": [ { "id": 243, "price": 16,
    //   "status": "available", "category": "BECE", ... }, ... ] } }
    const allItems: any[] = data.data?.items || [];
    const slots = allItems.filter((s) => !s.status || s.status === "available");
    if (!Array.isArray(slots) || slots.length === 0) {
      return { success: false, error: `No ${dbhCategory} checker slots currently available` };
    }

    const first = slots[0];
    const slotId = first?.id ?? first?.slot_id ?? first?.slotId;
    if (!slotId) {
      return { success: false, error: "DataBossHub returned a slot with no id field — check response shape" };
    }

    return { success: true, slotId: String(slotId) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error fetching slots" };
  }
}

// ── Buy the specific slot ────────────────────────────────────────────────────
interface BuyResult {
  success: boolean;
  data?: {
    slot_id?: string | number;
    serial?: string;
    pin?: string;
    exam_date?: string;
    results_link?: string;
    reference?: string;
    raw: unknown;
  };
  error?: string;
}

async function buySlot(apiKey: string, slotId: string): Promise<BuyResult> {
  try {
    const res = await fetch(`${DBH_BASE}/checker/buy/${encodeURIComponent(slotId)}`, {
      method: "POST",
      headers: dbhHeaders(apiKey),
    });

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `DataBossHub buy HTTP ${res.status}: ${text}` };
    }

    const data = await res.json();

    if (data.status !== "success" && data.status !== true) {
      return { success: false, error: `DataBossHub buy error: ${data.message || "Unknown error"}` };
    }

    // CONFIRMED shape (verified against a real response, 2026-07-31):
    // { status:"success", data:{ reference, slot_id, amount, message,
    //   slot:{ id, serial, pin, exam_date, results_link, purchase_reference,
    //          status, category } } }
    const slot = data.data?.slot;

    // Hard requirement: never mark an order "completed" without a real
    // serial/pin, even if DataBossHub said status:"success" — a successful
    // charge with missing credentials must go to manual_review, not silently
    // complete with blank fields (that was the bug: money taken, checker
    // sold on DataBossHub's side, nothing recorded for the customer).
    if (!slot?.serial || !slot?.pin) {
      return { success: false, error: `DataBossHub buy succeeded but returned no serial/pin — raw: ${JSON.stringify(data)}` };
    }

    return {
      success: true,
      data: {
        slot_id: slot.id ?? slotId,
        serial: slot.serial,
        pin: slot.pin,
        exam_date: slot.exam_date,
        results_link: slot.results_link,
        reference: data.data?.reference || slot.purchase_reference || String(slotId),
        raw: data,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error buying slot" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ status: false, message: "Method Not Allowed" }, 405);

  let order_id: string | undefined;
  let supabase: ReturnType<typeof createClient> | undefined;

  try {
    // ── Auth: JWT only, same as buy-data ──────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ status: false, message: "Unauthorized" }, 401);

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const { data: { user: authedUser }, error: authError } = await anonClient.auth.getUser(token);
    if (authError || !authedUser) return json({ status: false, message: "Unauthorized" }, 401);
    const user_id = authedUser.id;

    // ── Input ──────────────────────────────────────────────────────────────
    const { code, index_number } = await req.json();
    if (!code || typeof code !== "string") {
      return json({ status: false, message: "Missing required parameter: code" }, 400);
    }

    supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── Load product ───────────────────────────────────────────────────────
    const { data: product, error: productError } = await supabase
      .from("checker_products")
      .select("id, code, dbh_category, name, selling_price, requires_index_number, is_active")
      .eq("code", code.toLowerCase())
      .eq("is_active", true)
      .single();

    if (productError || !product) {
      return json({ status: false, message: "Checker type not available" }, 400);
    }

    // No index-number gate: purchase mirrors buy-data's flow — select type,
    // confirm, deduct. index_number is optional metadata only; DataBossHub's
    // buy call doesn't need it (it's entered later on WAEC's own site
    // alongside the serial/PIN), so it's never required to complete a sale.

    // ── SECURITY: price always from DB ────────────────────────────────────
    let finalPrice = parseFloat(product.selling_price as unknown as string);
    let priceSource = "base";

    const { data: customPrice } = await supabase
      .from("user_checker_prices")
      .select("custom_price")
      .eq("user_id", user_id)
      .eq("product_id", product.id)
      .maybeSingle();

    if (customPrice?.custom_price) {
      const parsed = parseFloat(customPrice.custom_price as unknown as string);
      if (!isNaN(parsed) && parsed > 0) {
        finalPrice = parsed;
        priceSource = "admin_custom";
      }
    }

    if (!finalPrice || finalPrice <= 0) {
      return json({ status: false, message: "This checker type is not priced yet — contact support" }, 400);
    }

    // ── Wallet check ───────────────────────────────────────────────────────
    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("id, balance, version, is_frozen")
      .eq("user_id", user_id)
      .single();

    if (walletError || !wallet) return json({ status: false, message: "Wallet not found" }, 400);
    if (wallet.is_frozen) {
      return json({ status: false, message: "Your wallet is frozen. Please contact support." }, 400);
    }

    const currentBalance = parseFloat(wallet.balance as unknown as string);
    if (currentBalance < finalPrice) {
      return json({
        status: false,
        message: `Insufficient balance. Required: GHS ${finalPrice.toFixed(2)}, Available: GHS ${currentBalance.toFixed(2)}`,
      }, 400);
    }

    // ── Create pending order row ──────────────────────────────────────────
    order_id = generateOrderId();
    const description = `${product.name} Purchase`;

    await supabase.from("checker_orders").upsert({
      order_reference: order_id,
      user_id,
      product_id: product.id,
      index_number: index_number || null,
      amount: finalPrice,
      status: "pending",
      idempotency_key: order_id,
      details: { price_source: priceSource, description },
    }, { onConflict: "order_reference" });

    // ── Debit wallet (optimistic lock) ────────────────────────────────────
    const newBalance = parseFloat((currentBalance - finalPrice).toFixed(2));
    const { error: walletUpdateError } = await supabase
      .from("wallets")
      .update({ balance: newBalance, version: wallet.version + 1, updated_at: new Date().toISOString() })
      .eq("id", wallet.id)
      .eq("version", wallet.version)
      .select("id");

    if (walletUpdateError) {
      await supabase.from("checker_orders").update({ status: "failed" }).eq("order_reference", order_id);
      return json({ status: false, message: "Wallet update failed. Please try again." }, 500);
    }

    // ── Call DataBossHub live: find a slot, then buy it ───────────────────
    const apiKey = Deno.env.get("DATABOSSHUB_API_KEY");
    if (!apiKey) {
      // Nothing was charged on DataBossHub's side — safe to auto-refund.
      await supabase.from("wallets")
        .update({ balance: currentBalance, version: wallet.version + 2, updated_at: new Date().toISOString() })
        .eq("id", wallet.id);
      await supabase.from("checker_orders").update({
        status: "failed",
        details: { price_source: priceSource, description, error: "DataBossHub API key not configured" },
      }).eq("order_reference", order_id);
      return json({ status: false, message: "Checker service temporarily unavailable. You have not been charged." }, 500);
    }

    const slotResult = await findAvailableSlot(apiKey, product.dbh_category);

    if (!slotResult.success) {
      // No slot found / slots call failed — nothing was charged. Auto-refund.
      await supabase.from("wallets")
        .update({ balance: currentBalance, version: wallet.version + 2, updated_at: new Date().toISOString() })
        .eq("id", wallet.id);
      await supabase.from("checker_orders").update({
        status: "failed",
        details: { price_source: priceSource, description, error: slotResult.error },
      }).eq("order_reference", order_id);
      return json({ status: false, message: `${product.name} is currently out of stock. You have not been charged.` }, 400);
    }

    const buyResult = await buySlot(apiKey, slotResult.slotId);

    if (!buyResult.success) {
      // A buy/{id} call was made — ambiguous whether DataBossHub charged us.
      // Do NOT auto-refund; flag for manual reconciliation, same as buy-data.
      await supabase.from("checker_orders").update({
        status: "manual_review",
        dbh_reference: slotResult.slotId,
        details: { price_source: priceSource, description, error: buyResult.error, balance_before: currentBalance, balance_after: newBalance },
      }).eq("order_reference", order_id);
      return json({
        status: true,
        message: "Order received and queued for manual processing. Your checker details will be sent to you shortly.",
        order_reference: order_id,
        manual_processing: true,
        new_balance: newBalance,
      }, 200);
    }

    // ── Success ────────────────────────────────────────────────────────────
    await supabase.from("checker_orders").update({
      status: "completed",
      serial_number: buyResult.data!.serial,
      pin: buyResult.data!.pin,
      dbh_reference: buyResult.data!.reference,
      details: {
        price_source: priceSource,
        description,
        balance_before: currentBalance,
        balance_after: newBalance,
        slot_id: buyResult.data!.slot_id,
        exam_date: buyResult.data!.exam_date,
        results_link: buyResult.data!.results_link,
      },
    }).eq("order_reference", order_id);

    return json({
      status: true,
      message: "Checker purchased successfully!",
      order_reference: order_id,
      product: product.name,
      slot_id: buyResult.data!.slot_id,
      serial_number: buyResult.data!.serial,
      pin: buyResult.data!.pin,
      exam_date: buyResult.data!.exam_date,
      results_link: buyResult.data!.results_link,
      amount_deducted: finalPrice,
      new_balance: newBalance,
    }, 200);

  } catch (error) {
    console.error("buy-checker unhandled error:", error);
    if (order_id && supabase) {
      await supabase.from("checker_orders").update({ status: "manual_review" }).eq("order_reference", order_id);
    }
    return json({ status: false, message: "Internal server error" }, 500);
  }
});