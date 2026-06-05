/**
 * get-store-data — Public edge function for store.html
 * Sections: info | bundles
 *
 * CHANGE (2026-04): Only accepts ?s=<short_code> — e.g. ?s=k3x9mw
 * Old ?slug=<uuid> links are explicitly rejected with HTTP 410 Gone.
 * Resolves short_code → owner_id server-side; the owner UUID is never
 * exposed in any public URL.
 *
 * CHANGE (2026-05): section=info now returns owner_email via a join on
 * the users table. store.html needs this to populate storeOwnerEmail so
 * it is sent to guest-buy-data in the purchase payload. Without it,
 * storeOwnerEmail was always null, causing edge function misrouting.
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

const SHORT_CODE_RE = /^[a-z0-9]{4,12}$/i; // 4–12 alphanumeric chars

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ success: false, message: "Method not allowed" }, 405);

  let section = "info", shortCode = "", network = "";
  try {
    const u = new URL(req.url);
    section   = u.searchParams.get("section") || "info";
    shortCode = (u.searchParams.get("s") || "").trim(); // only accept short code
    network   = (u.searchParams.get("network") || "").toLowerCase().trim();

    // Explicitly reject legacy ?slug= UUID links — store owners must use the new ?s= short link
    if (u.searchParams.get("slug")) {
      return json({ success: false, message: "This store link is no longer valid. Please request the updated link from the store owner." }, 410);
    }
  } catch {
    return json({ success: false, message: "Bad request URL" }, 400);
  }

  // ── Validate short code ───────────────────────────────────────────────────
  if (!shortCode) {
    return json({ success: false, message: "Missing store identifier" }, 400);
  }
  if (!SHORT_CODE_RE.test(shortCode)) {
    return json({ success: false, message: "Invalid store link" }, 400);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("get-store-data: missing env vars");
    return json({ success: false, message: "Server misconfiguration" }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── Resolve short_code → owner_id ───────────────────────────────────────
  const { data: storeRow, error: lookupErr } = await supabase
    .from("stores")
    .select("owner_id")
    .eq("short_code", shortCode)
    .eq("status", "active")
    .maybeSingle();

  if (lookupErr) {
    console.error("get-store-data short_code lookup error:", lookupErr);
    return json({ success: false, message: "Internal server error" }, 500);
  }
  if (!storeRow) {
    return json({ success: false, message: "Store not found" }, 404);
  }

  const ownerIdToQuery = storeRow.owner_id;
  console.log(`get-store-data: short_code=${shortCode} → owner_id=${ownerIdToQuery}`);

  // ── section=info ──────────────────────────────────────────────────────────
  if (section === "info") {
    try {
      // FIX (2026-05): join users table to get owner_email.
      // store.html assigns this to storeOwnerEmail and sends it in the
      // guest-buy-data purchase payload. Previously this was always null,
      // which caused edge function misrouting on some order paths.
      const { data, error } = await supabase
        .from("stores")
        .select(`
          id, name, owner_id, description,
          support_phone, whatsapp_support, whatsapp_group,
          theme_color, short_code,
          users!owner_id ( email )
        `)
        .eq("owner_id", ownerIdToQuery)
        .eq("status", "active")
        .maybeSingle();

      if (error) {
        console.error("get-store-data info query error:", JSON.stringify(error));
        return json({ success: false, message: error.message }, 500);
      }
      if (!data) {
        return json({ success: false, message: "Store not found" }, 404);
      }

      // Flatten the joined users row into a top-level owner_email field.
      // The store.html client reads storeData.owner_email directly.
      const ownerEmail = (data as any).users?.email ?? null;
      const { users: _drop, ...storeFields } = data as any;

      return json({ success: true, store: { ...storeFields, owner_email: ownerEmail } });
    } catch (e: any) {
      console.error("get-store-data info exception:", e?.message ?? e);
      return json({ success: false, message: "Internal server error" }, 500);
    }
  }

  // ── section=bundles ───────────────────────────────────────────────────────
  if (section === "bundles") {
    const validNetworks = ["mtn", "airteltigo", "telecel"];
    if (!validNetworks.includes(network)) {
      return json({ success: false, message: "Invalid network: " + network }, 400);
    }

    // Confirm store is still active before returning pricing data
    try {
      const { data: activeStore, error: storeErr } = await supabase
        .from("stores")
        .select("id")
        .eq("owner_id", ownerIdToQuery)
        .eq("status", "active")
        .maybeSingle();

      if (storeErr) {
        console.error("get-store-data stores check error:", JSON.stringify(storeErr));
        return json({ success: false, message: storeErr.message }, 500);
      }
      if (!activeStore) {
        return json({ success: false, message: "Store not found" }, 404);
      }
    } catch (e: any) {
      console.error("get-store-data stores check exception:", e?.message ?? e);
      return json({ success: false, message: "Internal server error" }, 500);
    }

    // Fetch bundles
    let baseBundles: any[] = [];
    try {
      const { data, error } = await supabase
        .from("bundles")
        .select("id, network, size, price, active")
        .eq("network", network)
        .eq("active", true)
        .order("size", { ascending: true });

      if (error) {
        console.error("get-store-data bundles query error:", JSON.stringify(error));
        return json({ success: false, message: error.message }, 500);
      }
      baseBundles = data || [];
    } catch (e: any) {
      console.error("get-store-data bundles exception:", e?.message ?? e);
      return json({ success: false, message: "Internal server error" }, 500);
    }

    if (baseBundles.length === 0) {
      return json({ success: true, bundles: [], adminCostMap: {}, priceMap: {} });
    }

    const bundleIds = baseBundles.map((b: any) => b.id);

    // Fetch pricing in parallel
    let adminCostMap: Record<string, number> = {};
    let priceMap: Record<string, number> = {};

    try {
      const { data: ubpData, error: ubpErr } = await supabase
        .from("user_bundle_prices")
        .select("bundle_id, custom_price")
        .eq("user_id", ownerIdToQuery)
        .in("bundle_id", bundleIds);

      if (ubpErr) {
        console.warn("get-store-data user_bundle_prices warning:", JSON.stringify(ubpErr));
      } else {
        (ubpData || []).forEach((r: any) => {
          adminCostMap[r.bundle_id] = parseFloat(r.custom_price);
        });
      }
    } catch (e: any) {
      console.warn("get-store-data user_bundle_prices exception (non-fatal):", e?.message ?? e);
    }

    try {
      const { data: sbpData, error: sbpErr } = await supabase
        .from("store_bundle_prices")
        .select("network, size, store_price")
        .eq("owner_id", ownerIdToQuery)
        .eq("network", network);

      if (sbpErr) {
        console.warn("get-store-data store_bundle_prices warning:", JSON.stringify(sbpErr));
      } else {
        (sbpData || []).forEach((r: any) => {
          priceMap[`${r.network}-${r.size}`] = parseFloat(r.store_price);
        });
      }
    } catch (e: any) {
      console.warn("get-store-data store_bundle_prices exception (non-fatal):", e?.message ?? e);
    }

    return json({
      success: true,
      bundles: baseBundles,
      adminCostMap,
      priceMap,
    });
  }

  return json({ success: false, message: `Unknown section: ${section}` }, 400);
});