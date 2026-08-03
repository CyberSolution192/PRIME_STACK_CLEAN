// checker-order-status — Look up one checker order by reference, or list the
// caller's checker order history. Mirrors track-order's shape but scoped to
// checker_orders. Only ever returns rows owned by the authenticated caller.
//
// GET ?reference=CHK-XXXX   -> single order
// GET (no reference)        -> recent history for the caller

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

const SAFE_COLUMNS =
  "order_reference, status, amount, serial_number, pin, index_number, details, created_at, updated_at, checker_products(code, name, official_check_url)";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ status: false, message: "Unauthorized" }, 401);

  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!
  );
  const { data: { user }, error: authError } = await anonClient.auth.getUser(token);
  if (authError || !user) return json({ status: false, message: "Unauthorized" }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const url = new URL(req.url);
  const reference = url.searchParams.get("reference");

  try {
    if (reference) {
      const { data: order, error } = await supabase
        .from("checker_orders")
        .select(SAFE_COLUMNS)
        .eq("order_reference", reference)
        .eq("user_id", user.id) // SECURITY: owner check — never trust the reference alone
        .maybeSingle();

      if (error) throw error;
      if (!order) return json({ status: false, message: "Order not found" }, 404);
      return json({ status: true, order });
    }

    const pageSize = Math.min(parseInt(url.searchParams.get("pageSize") || "20"), 100);
    const { data: orders, error } = await supabase
      .from("checker_orders")
      .select(SAFE_COLUMNS)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(pageSize);

    if (error) throw error;
    return json({ status: true, orders: orders || [] });
  } catch (error) {
    console.error("checker-order-status error:", error);
    return json({ status: false, message: "Failed to load order(s)" }, 500);
  }
});