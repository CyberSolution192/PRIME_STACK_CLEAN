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

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // ── Verify admin auth ──────────────────────────────────────────────────────
  // ── Internal secret — only admin-proxy knows this value ─────────────────
  const internalSecret = req.headers.get("x-internal-secret");
  if (!internalSecret || internalSecret !== Deno.env.get("ADMIN_INTERNAL_SECRET")) {
    return json({ success: false, message: "Forbidden" }, 403);
  }

  const userId = req.headers.get("x-admin-user-id");
  const role   = req.headers.get("x-admin-role");
  if (!userId || !role || !["admin", "superadmin"].includes(role)) {
    return json({ success: false, message: "Forbidden: admin access required" }, 403);
  }
  const user = { id: userId };

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: { text?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  // action: "save" (publish/update) or "clear" (hide)
  const action = body.action || "save";
  const text   = action === "clear" ? "" : (body.text?.trim() || "");
  const enabled = action !== "clear" && text.length > 0;

  try {
    const { error } = await supabase
      .from("system_settings")
      .upsert(
        {
          key:        "announcement",
          value:      text,
          enabled:    enabled,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );

    if (error) throw error;

    console.log(`✅ Announcement ${enabled ? "published" : "cleared"} by admin ${user.id}`);

    return json({
      success: true,
      message: enabled ? "Announcement published" : "Announcement cleared",
      active:  enabled,
      text,
    });

  } catch (err) {
    console.error("set-announcement error:", err);
    return json({ success: false, message: err instanceof Error ? err.message : "Failed to save" }, 500);
  }
});