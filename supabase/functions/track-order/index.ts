/**
 * track-order — Replaces unauthenticated direct read of adminorders in store.html
 *
 * FIXES: VULN-07 (public unauthenticated read of adminorders with select('*'))
 *
 * This is a PUBLIC endpoint (no auth required — it's a customer-facing store page).
 * However it:
 *  1. Only returns safe, customer-facing fields (no internal data)
 *  2. Requires both store_owner_id + phone to prevent enumeration
 *  3. Rate-limiting note: add Supabase rate-limit rules or a simple Redis counter
 *     in production
 *
 * GET /functions/v1/track-order?store_owner_id=<uuid>&phone=<phone>
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function normalizePhone(phone: string): string {
  phone = phone.replace(/\D/g, "");
  if (phone.startsWith("233")) phone = "0" + phone.slice(3);
  if (phone.startsWith("+233")) phone = "0" + phone.slice(4);
  return phone;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ success: false, message: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const storeOwnerId = url.searchParams.get("store_owner_id");
  const rawPhone = url.searchParams.get("phone");

  // Both params required — makes enumeration much harder
  if (!storeOwnerId || !rawPhone) {
    return json({ success: false, message: "Missing required parameters" }, 400);
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(storeOwnerId)) {
    return json({ success: false, message: "Invalid store ID format" }, 400);
  }

  const phone = normalizePhone(rawPhone);
  if (!/^0[0-9]{9}$/.test(phone)) {
    return json({ success: false, message: "Invalid phone number format" }, 400);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: orders, error } = await supabase
      .from("adminorders")
      // ONLY return customer-safe fields — no internal_response, no user IDs, no financial details
      .select("id, order_reference, network, package_size, status, created_at")
      .or("order_reference.like.STORE-%,order_reference.like.GST-%,order_reference.like.PAY-%")
      .filter("external_response->>storeownerid", "eq", storeOwnerId)
      .ilike("recipient", `%${phone.slice(-9)}%`)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw error;

    // Map to clean customer-facing shape — no raw DB fields exposed
    const safeOrders = (orders || []).map((o: any) => ({
      reference: o.order_reference,
      network: o.network?.toUpperCase(),
      size: o.package_size,
      status: o.status,
      date: o.created_at,
    }));

    return json({ success: true, orders: safeOrders });

  } catch (err) {
    console.error("track-order error:", err);
    return json({ success: false, message: "Failed to look up orders" }, 500);
  }
});
