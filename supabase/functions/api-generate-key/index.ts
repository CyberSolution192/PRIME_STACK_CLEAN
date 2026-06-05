/**
 * api-generate-key — Supabase Edge Function
 *
 * Called by: dashboard.html → API Access section
 * Routed via: user-proxy (Bearer session token — HttpOnly cookie flow)
 *
 * Generates a new API key for the authenticated reseller.
 * Rules:
 *   - One active key per user at a time. If one exists, it must be
 *     revoked before generating a new one (or pass force:true to auto-revoke).
 *   - Plain key is returned ONCE and never stored. Only the SHA-256 hash
 *     is persisted in the api_keys table.
 *   - key_prefix (first 12 chars) is stored for safe display in the dashboard.
 *
 * Actions (in request body):
 *   generate  — create a new key (optionally with a label)
 *   revoke    — deactivate the reseller's current key
 *   list      — return the reseller's key metadata (prefix, label, last_used_at, is_active)
 *
 * Request body (sent by user-proxy after stripping __target):
 *   { action: "generate", label?: string, force?: boolean }
 *   { action: "revoke" }
 *   { action: "list" }
 */

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

// ── SHA-256 helper ─────────────────────────────────────────────────────────────
async function sha256(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Secure random key generator ───────────────────────────────────────────────
function generatePlainKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pk_live_${hex}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // ── Auth: verify JWT forwarded by user-proxy ──────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, message: "Unauthorized" }, 401);

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return json({ success: false, message: "Invalid or expired token" }, 401);

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  const action = (body.action as string | undefined)?.trim();
  if (!action) return json({ success: false, message: "Missing action" }, 400);

  // ═══════════════════════════════════════════════════════
  // ACTION: list
  // Returns key metadata — never returns the hash or plain key
  // ═══════════════════════════════════════════════════════
  if (action === "list") {
    const { data: keys, error } = await supabase
      .from("api_keys")
      .select("id, key_prefix, label, is_active, last_used_at, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      console.error("[api-generate-key] list error:", error);
      return json({ success: false, message: "Failed to retrieve keys" }, 500);
    }

    return json({ success: true, keys: keys ?? [] });
  }

  // ═══════════════════════════════════════════════════════
  // ACTION: revoke
  // Deactivates all active keys for this user
  // ═══════════════════════════════════════════════════════
  if (action === "revoke") {
    const { error } = await supabase
      .from("api_keys")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("is_active", true);

    if (error) {
      console.error("[api-generate-key] revoke error:", error);
      return json({ success: false, message: "Failed to revoke key" }, 500);
    }

    console.log(`[api-generate-key] Key revoked for user ${user.id}`);
    return json({ success: true, message: "API key revoked successfully" });
  }

  // ═══════════════════════════════════════════════════════
  // ACTION: generate
  // Creates a new API key for the reseller
  // ═══════════════════════════════════════════════════════
  if (action === "generate") {
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 100) : null;
    const force = body.force === true;

    // Check for existing active key
    const { data: existingKey } = await supabase
      .from("api_keys")
      .select("id, key_prefix")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();

    if (existingKey && !force) {
      return json({
        success: false,
        message: "You already have an active API key. Revoke it first, or pass force:true to replace it.",
        existing_prefix: existingKey.key_prefix,
      }, 409);
    }

    // If force:true, revoke existing key first
    if (existingKey && force) {
      await supabase
        .from("api_keys")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .eq("is_active", true);

      console.log(`[api-generate-key] Force-revoked existing key for user ${user.id}`);
    }

    // Generate key
    const plainKey  = generatePlainKey();
    const keyHash   = await sha256(plainKey);
    const keyPrefix = plainKey.substring(0, 12); // "pk_live_a3f8"

    const { error: insertError } = await supabase
      .from("api_keys")
      .insert({
        user_id:    user.id,
        key_hash:   keyHash,
        key_prefix: keyPrefix,
        label:      label,
        is_active:  true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

    if (insertError) {
      console.error("[api-generate-key] insert error:", insertError);
      return json({ success: false, message: "Failed to generate API key" }, 500);
    }

    console.log(`[api-generate-key] New key generated for user ${user.id} — prefix: ${keyPrefix}`);

    // Return the plain key ONCE — it is never retrievable again
    return json({
      success:    true,
      message:    "API key generated. Save it now — it will not be shown again.",
      api_key:    plainKey,     // shown once only
      key_prefix: keyPrefix,   // safe to store and display
      label:      label,
      created_at: new Date().toISOString(),
    });
  }

  return json({ success: false, message: `Unknown action: ${action}` }, 400);
});