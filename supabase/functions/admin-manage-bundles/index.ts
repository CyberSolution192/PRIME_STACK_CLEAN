const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { user } = await verifyAdmin(supabase, req);
  if (!user) return json({ success: false, message: "Forbidden: admin access required" }, 403);/**
 * admin-manage-bundles — Replaces direct bundle CRUD in admin.html
 *
 * FIXES:
 *   VULN-01 (direct DB writes from frontend)
 *   VULN-02 (admin role enforced server-side, not just in JS)
 *   VULN-08 (adds server-side audit log for all admin mutations)
 *
 * POST /functions/v1/admin-manage-bundles
 * Body: { action: "list"|"create"|"update"|"delete", bundle?: {...}, bundleId?: string }
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

async function verifyAdmin(_supabase: ReturnType<typeof createClient>, req: Request) {
  // Verify this request came from admin-proxy (not a direct external call)
  const internalSecret = req.headers.get("x-internal-secret");
  if (!internalSecret || internalSecret !== Deno.env.get("ADMIN_INTERNAL_SECRET")) {
    return { user: null, profile: null };
  }

  const userId = req.headers.get("x-admin-user-id");
  const role   = req.headers.get("x-admin-role");
  if (!userId || !role) return { user: null, profile: null };
  if (!["admin", "superadmin"].includes(role)) return { user: null, profile: null };
  return { user: { id: userId }, profile: { role } };
}

async function auditLog(
  supabase: ReturnType<typeof createClient>,
  adminId: string,
  action: string,
  details: Record<string, unknown>
) {
  // Non-fatal — don't throw if audit log fails
  await supabase.from("admin_audit_log").insert({
    admin_id: adminId,
    action,
    details,
    created_at: new Date().toISOString(),
  }).then(({ error }) => {
    if (error) console.warn("⚠️ Audit log insert failed (non-fatal):", error.message);
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── Admin auth — reads proxy-injected headers (service role forwarded by admin-proxy) ──
  const { user } = await verifyAdmin(supabase, req);
  if (!user) {
    return json({ success: false, message: "Forbidden: admin access required" }, 403);
  }

  let body: { action?: string; bundle?: Record<string, unknown>; bundleId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  const { action, bundle, bundleId } = body;

  try {
    // ── LIST ───────────────────────────────────────────────────────────────
    if (action === "list") {
      const { data, error } = await supabase
        .from("bundles")
        .select("id, network, size, price, active, created_at")
        .order("network")
        .order("size");

      if (error) throw error;
      return json({ success: true, bundles: data });
    }

    // ── CREATE ─────────────────────────────────────────────────────────────
    if (action === "create") {
      if (!bundle) return json({ success: false, message: "Bundle data required" }, 400);

      // Server-side validation
      if (!bundle.network || typeof bundle.network !== "string") {
        return json({ success: false, message: "Invalid network" }, 400);
      }
      if (!bundle.size || typeof bundle.size !== "number" || bundle.size <= 0) {
        return json({ success: false, message: "Invalid bundle size" }, 400);
      }
      if (!bundle.price || typeof bundle.price !== "number" || bundle.price <= 0) {
        return json({ success: false, message: "Invalid price" }, 400);
      }

      const bundleData = {
        network: bundle.network.toLowerCase(),
        size: bundle.size,
        price: bundle.price,
        active: bundle.active !== false,
        created_at: new Date().toISOString(),
      };

      const { data, error } = await supabase
        .from("bundles")
        .insert(bundleData)
        .select("id")
        .single();

      if (error) throw error;

      await auditLog(supabase, user.id, "bundle_create", { bundleId: data.id, ...bundleData });
      console.log(`✅ Bundle created by admin ${user.id}:`, data.id);

      return json({ success: true, message: "Bundle created", bundleId: data.id });
    }

    // ── UPDATE ─────────────────────────────────────────────────────────────
    if (action === "update") {
      if (!bundleId || typeof bundleId !== "string") {
        return json({ success: false, message: "Bundle ID required" }, 400);
      }
      if (!bundle) return json({ success: false, message: "Bundle data required" }, 400);

      const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (bundle.price !== undefined) {
        if (typeof bundle.price !== "number" || bundle.price <= 0) {
          return json({ success: false, message: "Invalid price" }, 400);
        }
        updateData.price = bundle.price;
      }
      if (bundle.active !== undefined) updateData.active = !!bundle.active;
      if (bundle.size !== undefined) {
        if (typeof bundle.size !== "number" || bundle.size <= 0) {
          return json({ success: false, message: "Invalid size" }, 400);
        }
        updateData.size = bundle.size;
      }

      const { error } = await supabase
        .from("bundles")
        .update(updateData)
        .eq("id", bundleId);

      if (error) throw error;

      await auditLog(supabase, user.id, "bundle_update", { bundleId, changes: updateData });
      console.log(`✅ Bundle ${bundleId} updated by admin ${user.id}`);

      return json({ success: true, message: "Bundle updated" });
    }

    // ── DELETE ─────────────────────────────────────────────────────────────
    if (action === "delete") {
      if (!bundleId || typeof bundleId !== "string") {
        return json({ success: false, message: "Bundle ID required" }, 400);
      }

      // Soft-delete preferred: mark inactive rather than hard delete
      // to preserve historical order data integrity
      const { error } = await supabase
        .from("bundles")
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq("id", bundleId);

      if (error) throw error;

      await auditLog(supabase, user.id, "bundle_delete", { bundleId });
      console.log(`✅ Bundle ${bundleId} deactivated by admin ${user.id}`);

      return json({ success: true, message: "Bundle deactivated" });
    }

    return json({ success: false, message: `Unknown action: ${action}` }, 400);

  } catch (err) {
    console.error("admin-manage-bundles error:", err);
    return json({ success: false, message: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});