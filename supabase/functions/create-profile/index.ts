/**
 * create-profile — Creates the public.users profile row after Supabase Auth signup
 *
 * FIXES:
 *   VULN-01 — Removes direct .from('users').insert() from signup.html frontend
 *   ROLE-LOCK — role is ALWAYS hardcoded to 'user' server-side. A tampered
 *               request body cannot escalate a new signup to 'admin'.
 *   TRIGGER-RACE — if a DB trigger already created the bare row (id, email, role,
 *                  is_active only), we UPDATE it with fullname + phone instead of
 *                  skipping silently, so those fields are never left null.
 *   BALANCE-COL — removed balance: 0.00 from the insert; that column does not
 *                 exist in public.users and was causing the insert to fail.
 *
 * Called immediately after supabaseClient.auth.signUp() succeeds.
 * The fresh JWT from the new auth session is passed in the Authorization header,
 * so we can verify the caller is the actual newly-created user before inserting.
 *
 * POST /functions/v1/create-profile
 * Headers: Authorization: Bearer <access_token>
 * Body: { fullname: string, phone: string }   (email comes from the verified JWT)
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

  // ── Verify the JWT — confirms the caller is a real authenticated user ──────
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ success: false, message: "Unauthorized" }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return json({ success: false, message: "Invalid or expired token" }, 401);
  }

  // ── Parse and validate body ────────────────────────────────────────────────
  let body: { fullname?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  const fullname = (body.fullname || "").trim().slice(0, 100);
  const rawPhone = (body.phone || "").trim();

  if (!fullname) {
    return json({ success: false, message: "Full name is required" }, 400);
  }

  // Phone must be 9 digits (user types without the leading 0 or country code)
  if (!/^\d{9}$/.test(rawPhone)) {
    return json({ success: false, message: "Invalid phone number" }, 400);
  }

  const phone = `+233${rawPhone}`;

  // ── Guard: profile may already exist (e.g. DB trigger created it) ──────────
  const { data: existing } = await supabase
    .from("users")
    .select("id")
    .eq("id", user.id)
    .single();

  if (existing) {
    // FIX (TRIGGER-RACE): The DB trigger creates a bare row with only id/email/role/is_active.
    // Instead of skipping, UPDATE the row so fullname and phone are never left null.
    const { error: updateError } = await supabase
      .from("users")
      .update({
        fullname,
        phone,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (updateError) {
      console.error("create-profile update error:", updateError);
      return json({ success: false, message: "Failed to update profile" }, 500);
    }

    console.log(`✅ Profile updated for user ${user.id} (${user.email})`);
    return json({ success: true, message: "Profile updated" });
  }

  // ── Insert profile (trigger didn't fire) ───────────────────────────────────
  // SECURITY: role is ALWAYS 'user' — never read from the request body.
  // FIX (BALANCE-COL): balance column removed — it does not exist in public.users.
  const { error: insertError } = await supabase.from("users").insert({
    id: user.id,
    email: user.email,          // comes from the verified JWT, not the request body
    fullname,
    phone,
    role: "user",               // ← hardcoded — never trust the client for this
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (insertError) {
    // Duplicate key = profile was created by a concurrent request or DB trigger
    if (insertError.code === "23505") {
      return json({ success: true, message: "Profile already exists" });
    }
    console.error("create-profile insert error:", insertError);
    return json({ success: false, message: "Failed to create profile" }, 500);
  }

  console.log(`✅ Profile created for user ${user.id} (${user.email})`);
  return json({ success: true, message: "Profile created" });
});