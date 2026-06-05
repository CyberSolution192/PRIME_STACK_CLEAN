/**
 * update-profile — Replaces direct frontend UPDATE on users table
 *
 * FIXES: VULN-01 (direct DB write from frontend)
 *
 * Enforces:
 *  - User can only update their OWN profile (uid from JWT, not from request body)
 *  - Input sanitization and length limits server-side
 *  - Phone format validation
 *  - Email change goes through Supabase Auth (not direct DB update)
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

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, message: "Unauthorized" }, 401);

  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Server-side JWT verification
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return json({ success: false, message: "Invalid or expired token" }, 401);

  let body: { firstName?: string; lastName?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  // ── Validate and sanitize ──────────────────────────────────────────────────
  const firstName = (body.firstName || "").trim().slice(0, 50);
  const lastName = (body.lastName || "").trim().slice(0, 50);
  const phone = (body.phone || "").trim().slice(0, 20);

  if (!firstName && !lastName && !phone) {
    return json({ success: false, message: "Nothing to update" }, 400);
  }

  if (phone && !/^[0-9+\s\-()]{7,20}$/.test(phone)) {
    return json({ success: false, message: "Invalid phone number format" }, 400);
  }

  const fullname = [firstName, lastName].filter(Boolean).join(" ");

  try {
    const updateData: Record<string, string> = {
      updated_at: new Date().toISOString(),
    };
    if (fullname) updateData.fullname = fullname;
    if (phone) updateData.phone = phone;

    // Always filter by authenticated user's ID — never trust an ID from the request body
    const { data, error } = await supabase
      .from("users")
      .update(updateData)
      .eq("id", user.id)   // ← ALWAYS the authenticated user
      .select("id, fullname, email, phone")
      .single();

    if (error) throw error;

    return json({ success: true, message: "Profile updated", user: data });

  } catch (err) {
    console.error("update-profile error:", err);
    return json({ success: false, message: "Failed to update profile" }, 500);
  }
});
