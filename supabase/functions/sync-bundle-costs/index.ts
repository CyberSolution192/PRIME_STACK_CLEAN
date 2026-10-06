/**
 * sync-bundle-costs — Supabase Edge Function
 *
 * Pulls current bundle costs from each configured provider (Up2u, Bundle Zone GH)
 * and records what they currently charge us (cost_price) into
 * provider_bundle_costs. Never touches `bundles.price` (what we charge
 * customers) — that stays fully admin-controlled.
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
 *     'sync-bundle-costs',
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

// ─── Normalized shape every provider fetcher reduces down to ──────────────────
interface NormalizedBundle {
  network: string;   // lowercase: "mtn" | "telecel" | "airteltigo"
  sizeGb: number;
  validity: string;  // "monthly" | "weekly" | "daily"
  costPrice: number;
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

// Bundle Zone GH's network field in get_bundles is already "mtn"/"telecel" —
// but note their airteltigo network key is "ishare" everywhere in their API,
// including here, so we map it back to our internal "airteltigo" for storage.
function normalizeNetworkKey(network: string): string {
  const n = network.toLowerCase();
  if (n === "ishare") return "airteltigo";
  return n;
}

// ─── Provider: Up2u ─────────────────────────────────────────────────────────
async function fetchUp2uBundles(): Promise<NormalizedBundle[] | null> {
  const apiKey = Deno.env.get("UP2U_API_KEY");
  if (!apiKey) {
    console.error("[sync-bundle-costs] Up2u API key not configured — skipping");
    return null;
  }

  const res = await fetch("https://fmulclzwaohrzznsgalg.supabase.co/functions/v1/public-api/bundles", {
    method: "GET",
    headers: { "X-API-Key": apiKey },
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[sync-bundle-costs] Up2u HTTP ${res.status}: ${errText}`);
    return null;
  }

  const data = await res.json();
  const bundles = data.bundles || [];

  return bundles
    .map((b: any) => {
      const sizeGb = parseSizeGb(String(b.size));
      const costPrice = parseFloat(String(b.cost_price));
      if (!b.network || sizeGb === null || isNaN(costPrice)) return null;
      return {
        network: normalizeNetworkKey(String(b.network)),
        sizeGb,
        validity: parseValidity(b.validity || "30 days"),
        costPrice,
      };
    })
    .filter((b: NormalizedBundle | null): b is NormalizedBundle => b !== null);
}

// ─── Provider: Bundle Zone GH ───────────────────────────────────────────────
async function fetchBundleZoneGhBundles(): Promise<NormalizedBundle[] | null> {
  const apiKey = Deno.env.get("BUNDLEZONEGH_API_KEY");
  if (!apiKey) {
    console.error("[sync-bundle-costs] Bundle Zone GH API key not configured — skipping");
    return null;
  }

  const res = await fetch("https://shisywgbcadfyfbcupve.supabase.co/functions/v1/developer-api", {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "get_bundles" }),
  });

  let data: any = {};
  try { data = await res.json(); } catch { /* non-JSON body, data stays {} */ }

  if (!res.ok || data.success !== true) {
    console.error(`[sync-bundle-costs] BundleZoneGH fetch failed: HTTP ${res.status} — ${data.message || data.error || "unknown"}`);
    return null;
  }

  const bundles = data.data?.bundles || [];

  // "price" in get_bundles is what the account is actually charged (custom
  // pricing applied where configured) — that's our cost_price equivalent.
  return bundles
    .map((b: any) => {
      const sizeGb = typeof b.size_gb === "number" ? b.size_gb : parseSizeGb(String(b.size || ""));
      const costPrice = parseFloat(String(b.price));
      if (!b.network || sizeGb === null || isNaN(costPrice)) return null;
      return {
        network: normalizeNetworkKey(String(b.network)),
        sizeGb,
        validity: parseValidity(b.validity || "30 Days"),
        costPrice,
      };
    })
    .filter((b: NormalizedBundle | null): b is NormalizedBundle => b !== null);
}

const PROVIDERS: { name: string; fetch: () => Promise<NormalizedBundle[] | null> }[] = [
  { name: "up2u", fetch: fetchUp2uBundles },
  { name: "bundlezonegh", fetch: fetchBundleZoneGhBundles },
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ success: false, message: "Server configuration error" }, 500);
  }

  // ── Auth: only pg_cron / trusted service callers ──────────────────────────
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token || token !== SERVICE_KEY) {
    return json({ success: false, message: "Unauthorized" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const now = new Date().toISOString();

  const perProvider: Record<string, { synced: number; alerts: number; total: number; skipped: boolean }> = {};
  let totalSynced = 0;
  let totalAlerts = 0;

  for (const provider of PROVIDERS) {
    let bundles: NormalizedBundle[] | null = null;
    try {
      bundles = await provider.fetch();
    } catch (err) {
      console.error(`[sync-bundle-costs] ${provider.name} fetch threw:`, err);
    }

    if (bundles === null) {
      perProvider[provider.name] = { synced: 0, alerts: 0, total: 0, skipped: true };
      continue;
    }

    if (bundles.length === 0) {
      console.warn(`[sync-bundle-costs] ${provider.name} returned zero bundles`);
      perProvider[provider.name] = { synced: 0, alerts: 0, total: 0, skipped: false };
      continue;
    }

    let synced = 0;
    let alerts = 0;

    for (const b of bundles) {
      const { network, sizeGb, validity, costPrice } = b;

      // Look up the previous synced cost (if any) to detect a change.
      const { data: prevRow } = await supabase
        .from("provider_bundle_costs")
        .select("cost_price")
        .eq("provider", provider.name)
        .eq("network", network)
        .eq("size_gb", sizeGb)
        .eq("validity", validity)
        .maybeSingle();

      const { error: upsertError } = await supabase
        .from("provider_bundle_costs")
        .upsert(
          {
            provider: provider.name,
            network,
            size_gb: sizeGb,
            validity,
            cost_price: costPrice,
            synced_at: now,
          },
          { onConflict: "provider,network,size_gb,validity" }
        );

      if (upsertError) {
        console.error(`[sync-bundle-costs] ${provider.name} upsert failed for ${network} ${sizeGb}GB:`, upsertError.message);
        continue;
      }
      synced++;

      const priceChanged = prevRow && Math.abs(parseFloat(String(prevRow.cost_price)) - costPrice) > 0.001;

      // Compare against our own selling price for this network/size (monthly bundles only —
      // `bundles` table has no validity column, so daily/weekly provider costs are tracked
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
                ? `${provider.name} cost (GH₵${costPrice.toFixed(2)}) now EXCEEDS your ${network.toUpperCase()} ${sizeGb}GB selling price (GH₵${ourPrice.toFixed(2)}) — you are selling at a loss.`
                : `${provider.name} cost (GH₵${costPrice.toFixed(2)}) is within ${(MARGIN_ALERT_THRESHOLD * 100).toFixed(0)}% of your ${network.toUpperCase()} ${sizeGb}GB selling price (GH₵${ourPrice.toFixed(2)}).`,
              details: {
                provider: provider.name,
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

    console.log(`[sync-bundle-costs] ${provider.name}: synced ${synced}/${bundles.length}, raised ${alerts} alert(s)`);
    perProvider[provider.name] = { synced, alerts, total: bundles.length, skipped: false };
    totalSynced += synced;
    totalAlerts += alerts;
  }

  return json({ success: true, synced: totalSynced, alerts: totalAlerts, providers: perProvider });
});