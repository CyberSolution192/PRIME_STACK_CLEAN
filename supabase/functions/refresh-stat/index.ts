/**
 * refresh-stats — Supabase Edge Function
 *
 * Calls refresh_admin_dashboard_stats() for today and yesterday,
 * keeping the admin_dashboard_stats snapshot table current.
 *
 * Called by:
 *   1. pg_cron every hour:
 *      SELECT cron.schedule(
 *        'refresh-dashboard-stats',
 *        '0 * * * *',
 *        $$SELECT net.http_post(
 *          url := '<YOUR_SUPABASE_URL>/functions/v1/refresh-stats',
 *          headers := '{"Authorization": "Bearer <SERVICE_ROLE_KEY>"}'::jsonb
 *        )$$
 *      );
 *   2. admin.js on demand when admin opens dashboard (optional fast-path)
 *
 * Deploy:
 *   supabase functions deploy refresh-stats
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ success: false, message: "Server configuration error" }, 500);
  }

  // ── Auth: only service role callers (pg_cron, admin-manage-orders) allowed ──
  // This function runs expensive aggregate queries — protect it from public abuse.
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token || token !== SERVICE_KEY) {
    return json({ success: false, message: "Unauthorized" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // Always refresh today AND yesterday (yesterday may still have late orders
  // that completed after the last hourly run)
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const results: Record<string, unknown> = {};

  for (const date of [today, yesterday]) {
    const { data, error } = await supabase.rpc("refresh_admin_dashboard_stats", {
      p_date: date,
    });

    if (error) {
      console.error(`refresh_admin_dashboard_stats failed for ${date}:`, error.message);
      results[date] = { success: false, error: error.message };
    } else {
      console.log(`Refreshed stats for ${date}:`, data);
      results[date] = data;
    }
  }

  return json({ success: true, refreshed: results });
});