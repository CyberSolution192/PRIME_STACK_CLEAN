// get-checker-catalog — Lists active checker products (BECE/WASSCE/SHS
// Placement) with the authenticated caller's price. Replaces any direct
// frontend SELECT on checker_products / user_checker_prices.
//
// GET (no body needed) — Authorization: Bearer <jwt>

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

  try {
    const { data: products, error: productsError } = await supabase
      .from("checker_products")
      .select("id, code, name, description, official_check_url, requires_index_number, selling_price")
      .eq("is_active", true)
      .order("name");

    if (productsError) throw productsError;

    const { data: customPrices } = await supabase
      .from("user_checker_prices")
      .select("product_id, custom_price")
      .eq("user_id", user.id);

    const customByProduct = new Map((customPrices || []).map((r) => [r.product_id, r.custom_price]));

    const catalog = (products || []).map((p) => ({
      code: p.code,
      name: p.name,
      description: p.description,
      official_check_url: p.official_check_url,
      requires_index_number: p.requires_index_number,
      price: parseFloat(customByProduct.get(p.id) ?? p.selling_price),
    }));

    return json({ status: true, checkers: catalog });
  } catch (error) {
    console.error("get-checker-catalog error:", error);
    return json({ status: false, message: "Failed to load checker catalog" }, 500);
  }
});