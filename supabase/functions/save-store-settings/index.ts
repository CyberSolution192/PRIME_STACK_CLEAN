/**
 * save-store-settings — Replaces direct frontend upsert into stores table
 *
 * FIXES: VULN-01 (direct DB write), VULN-03 (no server validation)
 *
 * Validates all fields server-side and enforces owner_id = authenticated user.
 * A user can only ever update their OWN store — enforced in the WHERE clause
 * server-side, not relying on RLS alone.
 *
 * CHANGE (2026-04): On store creation, generates a unique 6-character
 * short_code (e.g. "k3x9mw") used in public store links instead of the
 * owner UUID. The short_code is returned in the response so the dashboard
 * can immediately build the correct short link.
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

function isValidHex(hex: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(hex);
}

function isValidPhone(phone: string): boolean {
  return /^[0-9+\s\-()]{7,20}$/.test(phone);
}

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Generates a random 6-character alphanumeric short code (lowercase, base-36).
 * e.g. "k3x9mw", "a1b2c3"
 * 36^6 = ~2.2 billion combinations — far more than enough for any store count.
 */
function generateShortCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  // Use crypto.getRandomValues for cryptographically random output
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) {
    code += chars[byte % chars.length];
  }
  return code;
}

/**
 * Generates a short_code that does not already exist in the stores table.
 * Retries up to 10 times (collision probability per attempt: ~1 in 2.2B).
 */
async function generateUniqueShortCode(
  supabase: ReturnType<typeof createClient>,
): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = generateShortCode();
    const { data } = await supabase
      .from("stores")
      .select("id")
      .eq("short_code", code)
      .maybeSingle();
    if (!data) return code; // no collision — use it
  }
  throw new Error("Failed to generate a unique short code — please try again");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, message: "Unauthorized" }, 401);

  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return json({ success: false, message: "Invalid or expired token" }, 401);

  let body: {
    name?: string;
    description?: string;
    support_phone?: string;
    whatsapp_support?: string;
    whatsapp_group?: string;
    theme_color?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  // ── Validate and sanitize all inputs server-side ──────────────────────────
  const name         = (body.name            || "").trim().slice(0, 100);
  const description  = (body.description    || "").trim().slice(0, 300);
  const supportPhone = (body.support_phone   || "").trim().slice(0, 20);
  const waSupport    = (body.whatsapp_support || "").trim().slice(0, 200);
  const waGroup      = (body.whatsapp_group  || "").trim().slice(0, 200);
  const themeColor   = (body.theme_color     || "#0ea5e9").trim();

  if (supportPhone && !isValidPhone(supportPhone)) {
    return json({ success: false, message: "Invalid support phone number" }, 400);
  }
  if (waSupport && !isValidUrl(waSupport)) {
    return json({ success: false, message: "WhatsApp support link must be a valid HTTPS URL" }, 400);
  }
  if (waGroup && !isValidUrl(waGroup)) {
    return json({ success: false, message: "WhatsApp group link must be a valid HTTPS URL" }, 400);
  }
  if (!isValidHex(themeColor)) {
    return json({ success: false, message: "Invalid theme color (must be hex like #0ea5e9)" }, 400);
  }

  const payload = {
    name:             name || undefined,
    description:      description || null,
    support_phone:    supportPhone || null,
    whatsapp_support: waSupport    || null,
    whatsapp_group:   waGroup      || null,
    theme_color:      themeColor,
    updated_at:       new Date().toISOString(),
  };

  try {
    // Check if store already exists for this user
    const { data: existing } = await supabase
      .from("stores")
      .select("id, short_code")
      .eq("owner_id", user.id)
      .maybeSingle();

    if (existing) {
      // ── UPDATE existing store ─────────────────────────────────────────────
      // If the store somehow has no short_code yet (pre-migration row that the
      // SQL backfill missed), generate one now so it's never left blank.
      if (!existing.short_code) {
        const code = await generateUniqueShortCode(supabase);
        (payload as any).short_code = code;
        console.log(`🔑 Backfill short_code for store ${existing.id}: ${code}`);
      }

      const { error } = await supabase
        .from("stores")
        .update(payload)
        .eq("owner_id", user.id); // ← user can ONLY update their own store

      if (error) throw error;

    } else {
      // ── CREATE new store ──────────────────────────────────────────────────
      const short_code = await generateUniqueShortCode(supabase);
      // Legacy slug column kept for backward compat — still written but not used for links
      const slug = "store-" + user.id.substring(0, 8);

      const { error } = await supabase
        .from("stores")
        .insert({
          owner_id: user.id,
          slug,
          short_code,
          status: "active",
          ...payload,
        });

      if (error) throw error;
      console.log(`🏪 New store created — user: ${user.id}, short_code: ${short_code}`);
    }

    // Return updated store including short_code so dashboard can build the link
    const { data: store } = await supabase
      .from("stores")
      .select("id, slug, short_code")
      .eq("owner_id", user.id)
      .single();

    console.log(`✅ Store settings saved — user: ${user.id}, short_code: ${store?.short_code}`);

    return json({
      success:    true,
      message:    "Store settings saved",
      storeId:    store?.id,
      slug:       store?.slug,
      short_code: store?.short_code,  // ← used by dashboard to build the short link
    });

  } catch (err) {
    console.error("save-store-settings error:", err);
    return json({ success: false, message: "Failed to save store settings" }, 500);
  }
});