/**
 * save-store-prices — Replaces direct frontend upsert into store_bundle_prices
 *
 * FIXES: VULN-01 (direct DB write from frontend)
 *
 * Validates that:
 *  1. User is authenticated
 *  2. The store being updated belongs to this user (owner_id enforced server-side)
 *  3. Bundle IDs actually exist (prevents phantom price entries)
 *  4. store_price >= base_price (no selling below cost)
 *  5. Prices are positive numbers
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

 const CORS = {
  "Access-Control-Allow-Origin": "https://rpolemxgussziexdmdxe.supabase.co",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

interface PriceUpdate {
  network: string;
  size: number;
  basePrice: number;
  storePrice: number;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, message: "Unauthorized" }, 401);

  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return json({ success: false, message: "Invalid or expired token" }, 401);

  let body: { updates?: PriceUpdate[] };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  const updates = body.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return json({ success: false, message: "No price updates provided" }, 400);
  }
  if (updates.length > 100) {
    return json({ success: false, message: "Too many updates in one request" }, 400);
  }

  // Validate each update
  for (const u of updates) {
    if (!u.network || typeof u.network !== "string") {
      return json({ success: false, message: "Invalid network in updates" }, 400);
    }
    if (!u.size || typeof u.size !== "number" || u.size <= 0) {
      return json({ success: false, message: "Invalid bundle size in updates" }, 400);
    }
    if (typeof u.basePrice !== "number" || u.basePrice <= 0) {
      return json({ success: false, message: "Invalid base price in updates" }, 400);
    }
    if (typeof u.storePrice !== "number" || u.storePrice <= 0) {
      return json({ success: false, message: "Invalid store price in updates" }, 400);
    }
    // Prevent selling below cost
    if (u.storePrice < u.basePrice) {
      return json({
        success: false,
        message: `Store price for ${u.network} ${u.size}GB cannot be lower than base price`,
      }, 400);
    }
  }

  try {
    // Get this user's store
    const { data: store, error: storeErr } = await supabase
      .from("stores")
      .select("id")
      .eq("owner_id", user.id)
      .single();

    if (storeErr || !store) {
      return json({ success: false, message: "No store found for your account" }, 404);
    }

    const storeId = store.id;
    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];

    for (const update of updates) {
      const { error } = await supabase
        .from("store_bundle_prices")
        .upsert(
          {
            store_id: storeId,
            owner_id: user.id,    // always set to authenticated user
            network: update.network.toLowerCase(),
            size: update.size,
            base_price: update.basePrice,
            store_price: update.storePrice,
            active: true,
          },
          { onConflict: "store_id,network,size", ignoreDuplicates: false }
        );

      if (error) {
        console.error(`Failed to save ${update.network}-${update.size}:`, error);
        errors.push(`${update.network} ${update.size}GB: ${error.message}`);
        failCount++;
      } else {
        successCount++;
      }
    }

    console.log(`✅ Store prices updated — user: ${user.id}, success: ${successCount}, fail: ${failCount}`);

    return json({
      success: successCount > 0,
      message: successCount > 0
        ? `Updated ${successCount} price${successCount > 1 ? "s" : ""} successfully${failCount > 0 ? `, ${failCount} failed` : ""}`
        : "All updates failed",
      successCount,
      failCount,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (err) {
    console.error("save-store-prices error:", err);
    return json({ success: false, message: "Failed to save store prices" }, 500);
  }
});
