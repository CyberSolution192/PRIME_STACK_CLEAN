// supabase/functions/get-site-status/index.ts
//
// PUBLIC Edge Function — no JWT required.
// Deploy with: supabase functions deploy get-site-status --no-verify-jwt
//
// Called by dashboard.html and store.html on EVERY page load, BEFORE auth.
// Returns the lock state for dashboard and store independently.
// The admin writes these via admin-manage-orders → set-setting action.
//
// Response shape:
// {
//   success:   true,
//   dashboard: { locked: bool, title, message, footer, icon } | { locked: false },
//   store:     { locked: bool, title, message, footer, icon } | { locked: false },
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Parse and sanitise a raw system_settings row into the shape the
// frontend expects. Returns { locked: false } if anything is wrong.
function parseLock(row: { value: string } | null): Record<string, unknown> {
  if (!row?.value) return { locked: false };
  try {
    const v = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    if (typeof v !== "object" || v === null) return { locked: false };
    if (!v.locked) return { locked: false };
    // Only expose safe display fields — never internal admin metadata
    return {
      locked:  true,
      title:   String(v.title   || "We Are Currently Closed"),
      message: String(v.message || ""),
      footer:  String(v.footer  || "Reopens soon."),
      icon:    String(v.icon    || "clock"),
    };
  } catch {
    return { locked: false };
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    // Fetch both lock settings in parallel
    const [dashRes, storeRes] = await Promise.all([
      supabase
        .from("system_settings")
        .select("value")
        .eq("key", "site_lock_dashboard")
        .maybeSingle(),
      supabase
        .from("system_settings")
        .select("value")
        .eq("key", "site_lock_store")
        .maybeSingle(),
    ]);

    // Log errors for debugging — never surface them to the browser
    if (dashRes.error)  console.error("site_lock_dashboard read error:", dashRes.error.message);
    if (storeRes.error) console.error("site_lock_store read error:",     storeRes.error.message);

    return json({
      success:   true,
      dashboard: parseLock(dashRes.data),
      store:     parseLock(storeRes.data),
    });

  } catch (err) {
    console.error("get-site-status fatal error:", err);
    // On any error return unlocked — never leave the site stuck locked
    return json({ success: true, dashboard: { locked: false }, store: { locked: false } });
  }
});