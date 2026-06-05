/**
 * get-public-bundles — Public edge function
 *
 * Returns all active bundles grouped by network.
 * Called by index.html (guest purchase page) to replace the direct
 * supabase.from('bundles') call that was previously in the frontend.
 *
 * No authentication required — bundle prices are public information.
 * No sensitive data is returned (no costs, no margins, no user data).
 *
 * GET /functions/v1/get-public-bundles
 * GET /functions/v1/get-public-bundles?network=mtn   (optional filter)
 *
 * Response:
 *   { success: true, bundles: { mtn: [...], telecel: [...], airteltigo: [...] } }
 *   { success: true, bundles: [...] }  when ?network= is specified
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

const VALID_NETWORKS = ["mtn", "telecel", "airteltigo"];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ success: false, message: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("get-public-bundles: missing env vars");
    return json({ success: false, message: "Server misconfiguration" }, 500);
  }

  let networkFilter = "";
  try {
    const u = new URL(req.url);
    networkFilter = (u.searchParams.get("network") || "").toLowerCase().trim();
  } catch {
    return json({ success: false, message: "Bad request URL" }, 400);
  }

  if (networkFilter && !VALID_NETWORKS.includes(networkFilter)) {
    return json({ success: false, message: `Invalid network. Must be one of: ${VALID_NETWORKS.join(", ")}` }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    let query = supabase
      .from("bundles")
      .select("id, network, size, price")
      .eq("active", true)
      .order("network", { ascending: true })
      .order("size",    { ascending: true });

    if (networkFilter) {
      query = query.eq("network", networkFilter);
    }

    const { data, error } = await query;

    if (error) {
      console.error("get-public-bundles query error:", error);
      return json({ success: false, message: "Failed to load bundles" }, 500);
    }

    const bundles = data || [];

    if (networkFilter) {
      // Return flat array when a specific network is requested
      return json({ success: true, bundles });
    }

    // Group by network when no filter
    const grouped: Record<string, any[]> = {};
    for (const b of bundles) {
      const net = b.network.toLowerCase();
      if (!grouped[net]) grouped[net] = [];
      grouped[net].push(b);
    }

    return json({ success: true, bundles: grouped });

  } catch (e: any) {
    console.error("get-public-bundles exception:", e?.message ?? e);
    return json({ success: false, message: "Internal server error" }, 500);
  }
});