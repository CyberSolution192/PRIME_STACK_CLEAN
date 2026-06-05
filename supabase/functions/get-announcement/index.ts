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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data, error } = await supabase
      .from("system_settings")
      .select("value, enabled")
      .eq("key", "announcement")
      .maybeSingle();

    if (error) throw error;

    // Return empty if no announcement or disabled
    const active = data && data.enabled !== false && data.value?.trim();

    return json({
      success: true,
      announcement: active ? data.value.trim() : "",
      active: !!active,
    });

  } catch (err) {
    console.error("get-announcement error:", err);
    return json({ success: false, announcement: "", active: false }, 500);
  }
});
