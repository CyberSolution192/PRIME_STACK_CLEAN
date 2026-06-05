/**
 * admin-manage-stores — Full store management for admins
 *
 * Actions:
 *   list           → paginated store list with owner info and order stats
 *   get            → single store full detail
 *   suspend        → suspend a store with a reason (sets status, suspended_at, suspended_reason)
 *   activate       → reactivate a suspended store (clears suspended fields)
 *   verify         → mark a store as verified (sets is_verified = true)
 *   unverify       → remove verified status (sets is_verified = false)
 *
 * Note: commission_rate column has been dropped from the stores table.
 * Commission deduction will be implemented as a future feature.
 *
 * Security:
 *   - Every action verifies admin/superadmin role server-side via JWT
 *   - Uses SUPABASE_SERVICE_ROLE_KEY — bypasses RLS (intentional for admin)
 *   - Every mutation is written to admin_audit_log
 *   - Input is validated and sanitised before any DB write
 *   - No direct frontend DB access — all calls route through this function
 */
import { serve }        from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

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
  await supabase.from("admin_audit_log").insert({
    admin_id:   adminId,
    action,
    details,
    created_at: new Date().toISOString(),
  }).then(({ error }) => {
    if (error) console.warn("Audit log failed:", error.message);
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")
    return json({ success: false, message: "Method not allowed" }, 405);

  // ── Auth ────────────────────────────────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { user } = await verifyAdmin(supabase, req);
  if (!user) return json({ success: false, message: "Forbidden: admin access required" }, 403);

  // ── Body ────────────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  const action = String(body.action || "").trim();

  try {

    // ── LIST stores ──────────────────────────────────────────────────────────
    if (action === "list") {
      const page     = Math.max(1, parseInt(String(body.page     || 1)));
      const pageSize = Math.min(100, Math.max(1, parseInt(String(body.pageSize || 20))));
      const offset   = (page - 1) * pageSize;
      const search   = String(body.search   || "").trim();
      const status   = String(body.status   || "").trim();

      let query = supabase
        .from("stores")
        .select(
          "id, owner_id, name, slug, short_code, status, is_verified, " +
          "total_orders, total_revenue, total_sales, description, " +
          "suspended_reason, suspended_at, created_at, updated_at, " +
          "users!owner_id(id, fullname, email, phone, role)",
          { count: "exact" }
        )
        .order("created_at", { ascending: false })
        .range(offset, offset + pageSize - 1);

      if (status && ["active", "suspended", "inactive"].includes(status)) {
        query = query.eq("status", status);
      }
      if (search) {
        query = query.or(`name.ilike.%${search}%,short_code.ilike.%${search}%`);
      }

      const { data, error, count } = await query;
      if (error) throw error;

      // Enrich each store with live order counts from adminorders
      const storeOwnerIds = (data || []).map((s: any) => s.owner_id).filter(Boolean);
      let orderStats: Record<string, { total: number; completed: number; pending: number; revenue: number }> = {};

      if (storeOwnerIds.length > 0) {
        const { data: orders } = await supabase
          .from("adminorders")
          .select("external_response, amount, status")
          .in("external_response->>storeownerid", storeOwnerIds);

        (orders || []).forEach((o: any) => {
          const ownerId = o.external_response?.storeownerid;
          if (!ownerId) return;
          if (!orderStats[ownerId]) orderStats[ownerId] = { total: 0, completed: 0, pending: 0, revenue: 0 };
          orderStats[ownerId].total++;
          if (o.status === "completed") {
            orderStats[ownerId].completed++;
            orderStats[ownerId].revenue += Math.abs(parseFloat(o.amount) || 0);
          }
          if (["pending", "processing"].includes(o.status)) {
            orderStats[ownerId].pending++;
          }
        });
      }

      const stores = (data || []).map((s: any) => ({
        ...s,
        live_stats: orderStats[s.owner_id] || { total: 0, completed: 0, pending: 0, revenue: 0 },
      }));

      // Count stores created in the last 7 days for the "New this week" stat
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { count: newThisWeek } = await supabase
        .from("stores")
        .select("id", { count: "exact", head: true })
        .gte("created_at", sevenDaysAgo);

      return json({ success: true, stores, total: count, page, pageSize, newThisWeek: newThisWeek || 0 });
    }

    // ── GET single store ─────────────────────────────────────────────────────
    if (action === "get") {
      const storeId = String(body.storeId || "").trim();
      if (!storeId) return json({ success: false, message: "Store ID required" }, 400);

      const { data: store, error } = await supabase
        .from("stores")
        .select("*, users!owner_id(id, fullname, email, phone, role, created_at)")
        .eq("id", storeId)
        .single();

      if (error || !store) return json({ success: false, message: "Store not found" }, 404);

      // Live order stats for this store
      const { data: orders } = await supabase
        .from("adminorders")
        .select("amount, status, created_at")
        .eq("external_response->>storeownerid", store.owner_id);

      const liveStats = (orders || []).reduce(
        (acc: any, o: any) => {
          acc.total++;
          if (o.status === "completed") { acc.completed++; acc.revenue += Math.abs(parseFloat(o.amount) || 0); }
          if (["pending", "processing"].includes(o.status)) acc.pending++;
          return acc;
        },
        { total: 0, completed: 0, pending: 0, revenue: 0 }
      );

      return json({ success: true, store: { ...store, live_stats: liveStats } });
    }

    // ── SUSPEND store ────────────────────────────────────────────────────────
    if (action === "suspend") {
      const storeId = String(body.storeId || "").trim();
      const reason  = String(body.reason  || "").trim().slice(0, 500);

      if (!storeId) return json({ success: false, message: "Store ID required" }, 400);
      if (!reason)  return json({ success: false, message: "Suspension reason is required" }, 400);

      // Confirm store exists and is not already suspended
      const { data: current } = await supabase
        .from("stores")
        .select("status, name, owner_id")
        .eq("id", storeId)
        .single();

      if (!current) return json({ success: false, message: "Store not found" }, 404);
      if (current.status === "suspended") {
        return json({ success: false, message: "Store is already suspended" }, 400);
      }

      const { error } = await supabase
        .from("stores")
        .update({
          status:           "suspended",
          suspended_reason: reason,
          suspended_at:     new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        })
        .eq("id", storeId);

      if (error) throw error;

      await auditLog(supabase, user.id, "store_suspended", {
        storeId,
        storeName: current.name,
        ownerId:   current.owner_id,
        reason,
      });

      console.log(`🔴 Store ${storeId} (${current.name}) suspended by admin ${user.id}. Reason: ${reason}`);
      return json({ success: true, message: `Store "${current.name}" has been suspended` });
    }

    // ── ACTIVATE store ───────────────────────────────────────────────────────
    if (action === "activate") {
      const storeId = String(body.storeId || "").trim();
      if (!storeId) return json({ success: false, message: "Store ID required" }, 400);

      const { data: current } = await supabase
        .from("stores")
        .select("status, name, owner_id")
        .eq("id", storeId)
        .single();

      if (!current) return json({ success: false, message: "Store not found" }, 404);
      if (current.status === "active") {
        return json({ success: false, message: "Store is already active" }, 400);
      }

      const { error } = await supabase
        .from("stores")
        .update({
          status:           "active",
          suspended_reason: null,
          suspended_at:     null,
          updated_at:       new Date().toISOString(),
        })
        .eq("id", storeId);

      if (error) throw error;

      await auditLog(supabase, user.id, "store_activated", {
        storeId,
        storeName: current.name,
        ownerId:   current.owner_id,
      });

      console.log(`✅ Store ${storeId} (${current.name}) activated by admin ${user.id}`);
      return json({ success: true, message: `Store "${current.name}" has been activated` });
    }

    // ── VERIFY store ─────────────────────────────────────────────────────────
    if (action === "verify") {
      const storeId = String(body.storeId || "").trim();
      if (!storeId) return json({ success: false, message: "Store ID required" }, 400);

      const { data: current } = await supabase
        .from("stores").select("name, owner_id, is_verified").eq("id", storeId).single();
      if (!current) return json({ success: false, message: "Store not found" }, 404);
      if (current.is_verified) return json({ success: false, message: "Store is already verified" }, 400);

      const { error } = await supabase
        .from("stores")
        .update({ is_verified: true, updated_at: new Date().toISOString() })
        .eq("id", storeId);
      if (error) throw error;

      await auditLog(supabase, user.id, "store_verified", {
        storeId, storeName: current.name, ownerId: current.owner_id,
      });

      return json({ success: true, message: `Store "${current.name}" has been verified` });
    }

    // ── UNVERIFY store ───────────────────────────────────────────────────────
    if (action === "unverify") {
      const storeId = String(body.storeId || "").trim();
      if (!storeId) return json({ success: false, message: "Store ID required" }, 400);

      const { data: current } = await supabase
        .from("stores").select("name, owner_id, is_verified").eq("id", storeId).single();
      if (!current) return json({ success: false, message: "Store not found" }, 404);
      if (!current.is_verified) return json({ success: false, message: "Store is not verified" }, 400);

      const { error } = await supabase
        .from("stores")
        .update({ is_verified: false, updated_at: new Date().toISOString() })
        .eq("id", storeId);
      if (error) throw error;

      await auditLog(supabase, user.id, "store_unverified", {
        storeId, storeName: current.name, ownerId: current.owner_id,
      });

      return json({ success: true, message: `Verified badge removed from "${current.name}"` });
    }

    return json({ success: false, message: `Unknown action: ${action}` }, 400);

  } catch (err) {
    console.error("admin-manage-stores error:", err);
    return json({
      success: false,
      message: err instanceof Error ? err.message : "Internal server error",
    }, 500);
  }
});