/**
 * sync-bundle-costs — Supabase Edge Function
 *
 * Pulls GET /bundles from Up2u and records what they currently charge us
 * (cost_price) into provider_bundle_costs. Never touches `bundles.price`
 * (what we charge customers) — that stays fully admin-controlled.
 *
 * If a provider's cost has risen above (or too close to) our selling price
 * for a network/size, writes a row to admin_alerts so it surfaces in the
 * admin dashboard instead of silently eating margin.
 *
 * Auth: service-role bearer only (same pattern as refresh-stat).
 * Not callable by the frontend, resellers, or anyone without the service key.
 *
 * Deploy:
 *   supabase functions deploy sync-bundle-costs --no-verify-jwt
 *
 * Schedule (run in SQL editor once, after deploying):
 *   select cron.schedule(
 *     'sync-up2u-bundle-costs',
 *     '0 0/6 * * *',  -- every 6 hours (standard cron syntax — adjust as needed)
 *     $$select net.http_post(
 *       url := '<YOUR_SUPABASE_URL>/functions/v1/sync-bundle-costs',
 *       headers := jsonb_build_object(
 *         'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
 *         'Content-Type', 'application/json'
 *       )
 *     )$$
 *   );
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { raiseAlert } from "../_shared/admin-alerts.ts";

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

// Margin-safety threshold: alert if cost_price is within this fraction of
// our selling price (or above it). 0.02 = alert once margin drops under 2%.
const MARGIN_ALERT_THRESHOLD = 0.02;

interface Up2uBundle {
  id: number;
  network: string;   // "MTN" | "TELECEL" | "AIRTELTIGO"
  size: string;       // "1GB", "2GB", etc.
  validity: string;   // "30 days" | "7 days" | "1 day" — free text from their API
  cost_price: number;
  your_price: number;
}

function parseSizeGb(size: string): number | null {
  const match = size.match(/([\d.]+)\s*GB/i);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseValidity(validity: string): string {
  const v = validity.toLowerCase();
  if (v.includes("day") && !v.includes("30")) return v.includes("7") ? "weekly" : "daily";
  return "monthly"; // 30 days / default
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const UP2U_API_KEY = Deno.env.get("UP2U_API_KEY");

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ success: false, message: "Server configuration error" }, 500);
  }

  // ── Auth: only pg_cron / trusted service callers ──────────────────────────
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token || token !== SERVICE_KEY) {
    return json({ success: false, message: "Unauthorized" }, 401);
  }

  if (!UP2U_API_KEY) {
    return json({ success: false, message: "Up2u API key not configured" }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const res = await fetch("https://fmulclzwaohrzznsgalg.supabase.co/functions/v1/public-api/bundles", {
      method: "GET",
      headers: { "X-API-Key": UP2U_API_KEY },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[sync-bundle-costs] Up2u HTTP ${res.status}: ${errText}`);
      return json({ success: false, message: `Up2u bundles fetch failed: HTTP ${res.status}` }, 502);
    }

    const data = await res.json();
    const bundles: Up2uBundle[] = data.bundles || [];

    if (bundles.length === 0) {
      console.warn("[sync-bundle-costs] Up2u returned zero bundles");
      return json({ success: true, synced: 0, alerts: 0, message: "No bundles returned" });
    }

    let synced = 0;
    let alerts = 0;
    const now = new Date().toISOString();

    for (const b of bundles) {
      const network  = b.network.toLowerCase();
      const sizeGb    = parseSizeGb(b.size);
      const validity  = parseValidity(b.validity || "30 days");
      const costPrice = parseFloat(String(b.cost_price));

      if (!network || sizeGb === null || isNaN(costPrice)) {
        console.warn("[sync-bundle-costs] Skipping unparsable bundle:", JSON.stringify(b));
        continue;
      }

      // Look up the previous synced cost (if any) to detect a change.
      const { data: prevRow } = await supabase
        .from("provider_bundle_costs")
        .select("cost_price")
        .eq("provider", "up2u")
        .eq("network", network)
        .eq("size_gb", sizeGb)
        .eq("validity", validity)
        .maybeSingle();

      const { error: upsertError } = await supabase
        .from("provider_bundle_costs")
        .upsert(
          {
            provider: "up2u",
            network,
            size_gb: sizeGb,
            validity,
            cost_price: costPrice,
            synced_at: now,
          },
          { onConflict: "provider,network,size_gb,validity" }
        );

      if (upsertError) {
        console.error(`[sync-bundle-costs] Upsert failed for ${network} ${sizeGb}GB:`, upsertError.message);
        continue;
      }
      synced++;

      const priceChanged = prevRow && Math.abs(parseFloat(String(prevRow.cost_price)) - costPrice) > 0.001;

      // Compare against our own selling price for this network/size (monthly bundles only —
      // `bundles` table has no validity column, so daily/weekly Up2u costs are tracked
      // for visibility but not compared against a selling price).
      if (validity === "monthly") {
        const { data: ourBundle } = await supabase
          .from("bundles")
          .select("price")
          .eq("network", network)
          .eq("size", sizeGb)
          .eq("active", true)
          .maybeSingle();

        if (ourBundle) {
          const ourPrice = parseFloat(String(ourBundle.price));
          const margin = (ourPrice - costPrice) / (ourPrice || 1);

          if (margin < MARGIN_ALERT_THRESHOLD) {
            await raiseAlert(supabase, {
              type: "price_drift",
              severity: margin < 0 ? "HIGH" : "MEDIUM",
              message: margin < 0
                ? `Up2u cost (GH₵${costPrice.toFixed(2)}) now EXCEEDS your ${network.toUpperCase()} ${sizeGb}GB selling price (GH₵${ourPrice.toFixed(2)}) — you are selling at a loss.`
                : `Up2u cost (GH₵${costPrice.toFixed(2)}) is within ${(MARGIN_ALERT_THRESHOLD * 100).toFixed(0)}% of your ${network.toUpperCase()} ${sizeGb}GB selling price (GH₵${ourPrice.toFixed(2)}).`,
              details: {
                provider: "up2u",
                network,
                size_gb: sizeGb,
                cost_price: costPrice,
                your_price: ourPrice,
                margin: parseFloat(margin.toFixed(4)),
                price_changed_since_last_sync: !!priceChanged,
              },
            });
            alerts++;
          }
        }
      }
    }

    console.log(`[sync-bundle-costs] Synced ${synced}/${bundles.length} bundles, raised ${alerts} alert(s)`);
    return json({ success: true, synced, total: bundles.length, alerts });
  } catch (err) {
    console.error("[sync-bundle-costs] Unhandled error:", err);
    return json({ success: false, message: "Internal server error" }, 500);
  }
});