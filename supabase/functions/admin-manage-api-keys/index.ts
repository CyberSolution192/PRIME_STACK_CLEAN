/**
 * admin-manage-api-keys — Supabase Edge Function
 *
 * Called by: admin.html → API Keys section
 * Routed via: admin-proxy (admin session token)
 *
 * Actions:
 *   list          — paginated list of all issued API keys with reseller info
 *   revoke        — deactivate any key by id (admin-level)
 *   get-orders    — list API-originated orders for a specific key or all keys
 *   get-stats     — summary counts: total keys, active keys, total API orders
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
  return { user: { id: userId }, profile: { role, fullname: "Admin" } };
}

async function auditLog(
  supabase: ReturnType<typeof createClient>,
  adminId: string,
  action: string,
  details: Record<string, unknown>
) {
  await supabase.from("admin_audit_log").insert({
    admin_id:   adminId,
    action,
    details,
    created_at: new Date().toISOString(),
  }).then(({ error }: { error: any }) => {
    if (error) console.warn("[admin-manage-api-keys] Audit log failed:", error.message);
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // ── Auth: admin only ──────────────────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const admin = await verifyAdmin(supabase, req);
  if (!admin.user) return json({ success: false, message: "Unauthorized — admin access required" }, 403);

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  const action   = (body.action as string | undefined)?.trim();
  const page     = Math.max(1, parseInt(String(body.page || 1)));
  const pageSize = Math.min(50, Math.max(1, parseInt(String(body.page_size || 20))));
  const offset   = (page - 1) * pageSize;

  if (!action) return json({ success: false, message: "Missing action" }, 400);

  // ═══════════════════════════════════════════════════════
  // ACTION: list
  // Paginated list of all API keys with reseller name/email
  // ═══════════════════════════════════════════════════════
  if (action === "list") {
    const filterActive = body.is_active; // true | false | undefined (all)

    let query = supabase
      .from("api_keys")
      .select("id, user_id, key_prefix, label, is_active, request_count, last_used_at, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (filterActive !== undefined && filterActive !== null) {
      query = query.eq("is_active", filterActive === true || filterActive === "true");
    }

    const { data: keys, count, error } = await query;

    if (error) {
      console.error("[admin-manage-api-keys] list error:", error.message);
      return json({ success: false, message: "Failed to retrieve API keys" }, 500);
    }

    // Enrich with user info from public.users (separate query — api_keys refs auth.users)
    const userIds = [...new Set((keys ?? []).map((k: any) => k.user_id))];
    let userMap: Record<string, any> = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, fullname, email, phone")
        .in("id", userIds);
      if (users) {
        for (const u of users) userMap[u.id] = u;
      }
    }

    const enrichedKeys = (keys ?? []).map((k: any) => ({
      ...k,
      users: userMap[k.user_id] ?? null,
    }));

    return json({
      success: true,
      keys:    enrichedKeys,
      total:   count ?? 0,
      page,
      page_size: pageSize,
    });
  }

  // ═══════════════════════════════════════════════════════
  // ACTION: revoke
  // Admin deactivates any key by its id
  // ═══════════════════════════════════════════════════════
  if (action === "revoke") {
    const keyId = (body.key_id as string | undefined)?.trim();
    if (!keyId) return json({ success: false, message: "Missing key_id" }, 400);

    // Fetch key info for audit log
    const { data: keyInfo } = await supabase
      .from("api_keys")
      .select("id, user_id, key_prefix, is_active")
      .eq("id", keyId)
      .maybeSingle();

    if (!keyInfo) return json({ success: false, message: "API key not found" }, 404);
    if (!keyInfo.is_active) return json({ success: false, message: "Key is already revoked" }, 400);

    const { error } = await supabase
      .from("api_keys")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", keyId);

    if (error) {
      console.error("[admin-manage-api-keys] revoke error:", error.message);
      return json({ success: false, message: "Failed to revoke key" }, 500);
    }

    await auditLog(supabase, admin.user.id, "api_key_revoked", {
      key_id:     keyId,
      key_prefix: keyInfo.key_prefix,
      owner_id:   keyInfo.user_id,
    });

    console.log(`[admin-manage-api-keys] Key ${keyId} revoked by admin ${admin.user.id}`);
    return json({ success: true, message: "API key revoked successfully" });
  }

  // ═══════════════════════════════════════════════════════
  // ACTION: get-orders
  // List API-originated orders (optionally filtered by key)
  // ═══════════════════════════════════════════════════════
  if (action === "get-orders") {
    const keyId  = (body.key_id  as string | undefined)?.trim() || null;
    const status = (body.status  as string | undefined)?.trim() || null;

    let query = supabase
      .from("api_orders")
      .select("id, order_reference, user_id, api_key_id, network, phone, size, amount, status, provider, manual_fallback, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (keyId)  query = query.eq("api_key_id", keyId);
    if (status) query = query.eq("status", status);

    const { data: orders, count, error } = await query;

    if (error) {
      console.error("[admin-manage-api-keys] get-orders error:", error.message);
      return json({ success: false, message: "Failed to retrieve orders" }, 500);
    }

    // Enrich with user info from public.users (separate query — api_orders refs auth.users)
    const orderUserIds = [...new Set((orders ?? []).map((o: any) => o.user_id))];
    let orderUserMap: Record<string, any> = {};
    if (orderUserIds.length > 0) {
      const { data: orderUsers } = await supabase
        .from("users")
        .select("id, fullname, email")
        .in("id", orderUserIds);
      if (orderUsers) {
        for (const u of orderUsers) orderUserMap[u.id] = u;
      }
    }

    const enrichedOrders = (orders ?? []).map((o: any) => ({
      ...o,
      users: orderUserMap[o.user_id] ?? null,
    }));

    return json({
      success: true,
      orders:  enrichedOrders,
      total:   count ?? 0,
      page,
      page_size: pageSize,
    });
  }

  // ═══════════════════════════════════════════════════════
  // ACTION: get-stats
  // Summary counts for admin dashboard card
  // ═══════════════════════════════════════════════════════
  if (action === "get-stats") {
    const [totalKeys, activeKeys, totalOrders, pendingOrders, completedOrders, failedOrders] = await Promise.all([
      supabase.from("api_keys").select("id", { count: "exact", head: true }),
      supabase.from("api_keys").select("id", { count: "exact", head: true }).eq("is_active", true),
      supabase.from("api_orders").select("id", { count: "exact", head: true }),
      supabase.from("api_orders").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("api_orders").select("id", { count: "exact", head: true }).eq("status", "completed"),
      supabase.from("api_orders").select("id", { count: "exact", head: true }).eq("status", "failed"),
    ]);

    return json({
      success: true,
      stats: {
        total_keys:       totalKeys.count       ?? 0,
        active_keys:      activeKeys.count      ?? 0,
        total_orders:     totalOrders.count     ?? 0,
        pending_orders:   pendingOrders.count   ?? 0,
        completed_orders: completedOrders.count ?? 0,
        failed_orders:    failedOrders.count    ?? 0,
      },
    });
  }
  // ═══════════════════════════════════════════════════════
  // ACTION: update-status
  // Temporary debug handler
  // ═══════════════════════════════════════════════════════

  if (action === "update-status") {

    const orderId = (body.orderId as string | undefined)?.trim();
    const status = (body.status as string | undefined)?.trim();

    if (!orderId || !status) {
      return json({
        success: false,
        message: "Missing orderId or status"
      }, 400);
    }

    console.log(
      `[admin-manage-api-keys] update-status: ${orderId} -> ${status}`
    );

    return json({
      success: true,
      message: "Debug handler reached successfully",
      orderId,
      status
    });
  }
  return json({ success: false, message: `Unknown action: ${action}` }, 400);
});
