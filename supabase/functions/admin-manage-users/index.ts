/**
 * admin-manage-users — MERGED + 2026-05 patch
 *
 * Changes in this version:
 *   - serve() → Deno.serve() (Supabase v3 runtime fix)
 *   - get-reseller-profits: removed user_note filter from withdrawals query.
 *     The user_note column was deleted from withdrawal_requests. All completed
 *     withdrawals for store owners are now counted as profit withdrawals — this
 *     is correct because store owners only withdraw against profit earnings.
 *   - No other logic changed
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
    admin_id: adminId,
    action,
    details,
    created_at: new Date().toISOString(),
  }).then(({ error }) => {
    if (error) console.warn("Audit log failed:", error.message);
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

    const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { user } = await verifyAdmin(supabase, req);
  if (!user) return json({ success: false, message: "Forbidden: admin access required" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  const action = body.action as string;

  try {

    // ── LIST users (paginated) ─────────────────────────────────────────────
    if (action === "list") {
      const page = Math.max(1, parseInt(String(body.page || 1)));
      const pageSize = Math.min(50, parseInt(String(body.pageSize || 20)));
      const offset = (page - 1) * pageSize;
      const search = body.search as string | undefined;

      let query = supabase
        .from("users")
        .select("id, fullname, email, phone, role, store_unlocked, created_at", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(offset, offset + pageSize - 1);

      if (search) {
        query = query.or(`fullname.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
      }

      const { data, error, count } = await query;
      if (error) throw error;

      const userIds = (data || []).map((u: any) => u.id);
      let walletMap: Record<string, number> = {};
      if (userIds.length > 0) {
        const { data: wallets } = await supabase
          .from("wallets")
          .select("user_id, balance")
          .in("user_id", userIds);
        (wallets || []).forEach((w: any) => {
          walletMap[w.user_id] = parseFloat(w.balance);
        });
      }

      const enriched = (data || []).map((u: any) => ({
        ...u,
        balance: walletMap[u.id] ?? 0,
      }));

      return json({ success: true, users: enriched, total: count, page, pageSize });
    }

    // ── GET single user ────────────────────────────────────────────────────
    if (action === "get") {
      const targetUserId = body.userId as string;
      if (!targetUserId) return json({ success: false, message: "User ID required" }, 400);

      const [userRes, walletRes, ordersRes, txRes] = await Promise.all([
        supabase.from("users")
          .select("id, fullname, email, phone, role, store_unlocked, created_at")
          .eq("id", targetUserId)
          .single(),
        supabase.from("wallets")
          .select("balance")
          .eq("user_id", targetUserId)
          .single(),
        supabase.from("adminorders")
          .select("id, order_reference, network, package_size, amount, status, created_at")
          .eq("userid", targetUserId)
          .order("created_at", { ascending: false })
          .limit(10),
        supabase.from("transactions")
          .select("id, type, amount, description, created_at")
          .eq("userid", targetUserId)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

      if (userRes.error) throw userRes.error;

      return json({
        success: true,
        user: userRes.data,
        balance: walletRes.data?.balance ?? 0,
        recentOrders: ordersRes.data || [],
        recentTransactions: txRes.data || [],
      });
    }

    // ── UPDATE ROLE ────────────────────────────────────────────────────────
    if (action === "update-role") {
      const targetUserId = body.userId as string;
      const newRole = body.role as string;
      const ALLOWED_ROLES = ["user", "reseller", "admin"];

      if (!targetUserId) return json({ success: false, message: "User ID required" }, 400);
      if (!newRole || !ALLOWED_ROLES.includes(newRole)) {
        return json({ success: false, message: `Invalid role. Allowed: ${ALLOWED_ROLES.join(", ")}` }, 400);
      }

      const { data: target } = await supabase
        .from("users")
        .select("role")
        .eq("id", targetUserId)
        .single();

      if (target?.role === "superadmin") {
        return json({ success: false, message: "Cannot modify superadmin role" }, 403);
      }

      const { error } = await supabase
        .from("users")
        .update({ role: newRole, updated_at: new Date().toISOString() })
        .eq("id", targetUserId);

      if (error) throw error;

      await auditLog(supabase, user.id, "user_role_update", {
        targetUserId,
        fromRole: target?.role,
        toRole: newRole,
      });

      return json({ success: true, message: "User role updated" });
    }

    // ── SET CUSTOM BUNDLE PRICES ───────────────────────────────────────────
    if (action === "set-bundle-prices") {
      const targetUserId = body.userId as string;
      const prices = body.prices as Array<{ bundle_id: string; custom_price: number }>;

      if (!targetUserId) return json({ success: false, message: "User ID required" }, 400);
      if (!Array.isArray(prices)) return json({ success: false, message: "Prices array required" }, 400);

      for (const p of prices) {
        if (!p.bundle_id || typeof p.bundle_id !== "string") {
          return json({ success: false, message: "Invalid bundle_id in prices" }, 400);
        }
        if (typeof p.custom_price !== "number" || p.custom_price < 0) {
          return json({ success: false, message: "Invalid custom_price — must be a non-negative number" }, 400);
        }
      }

      const bundleIds = prices.map((p) => p.bundle_id);
      const { data: bundles, error: bundleErr } = await supabase
        .from("bundles")
        .select("id, network, size, price")
        .in("id", bundleIds);
      if (bundleErr) throw bundleErr;

      const bundleMap: Record<string, { network: string; size: number; price: number }> = {};
      (bundles || []).forEach((b: any) => {
        bundleMap[b.id] = { network: b.network, size: b.size, price: parseFloat(b.price) };
      });

      const { error: deleteErr } = await supabase
        .from("user_bundle_prices")
        .delete()
        .eq("user_id", targetUserId);

      if (deleteErr) throw deleteErr;

      if (prices.length > 0) {
        const rows = prices.map((p) => {
          const bundle = bundleMap[p.bundle_id];
          if (!bundle) throw new Error(`Bundle not found: ${p.bundle_id}`);
          return {
            user_id:      targetUserId,
            bundle_id:    p.bundle_id,
            network:      bundle.network,
            size:         bundle.size,
            base_price:   bundle.price,
            custom_price: p.custom_price,
            created_by:   user.id,
          };
        });

        const { error: insertErr } = await supabase
          .from("user_bundle_prices")
          .insert(rows);

        if (insertErr) throw insertErr;
      }

      await auditLog(supabase, user.id, "user_bundle_prices_set", {
        targetUserId,
        priceCount: prices.length,
      });

      return json({ success: true, message: `${prices.length} custom prices set` });
    }

    // ── GET DASHBOARD STATS ────────────────────────────────────────────────
    if (action === "get-stats") {
      const [usersRes, storesRes, walletsRes] = await Promise.all([
        supabase.from("users").select("id, role", { count: "exact" }),
        supabase.from("stores").select("id", { count: "exact" }),
        supabase.from("wallets").select("balance"),
      ]);

      const totalBalance = (walletsRes.data || []).reduce(
        (sum: number, w: any) => sum + parseFloat(w.balance || 0), 0
      );

      const roleCounts: Record<string, number> = {};
      (usersRes.data || []).forEach((u: any) => {
        roleCounts[u.role] = (roleCounts[u.role] || 0) + 1;
      });

      return json({
        success: true,
        stats: {
          totalUsers: usersRes.count || 0,
          totalStores: storesRes.count || 0,
          totalWalletBalance: totalBalance,
          byRole: roleCounts,
        },
      });
    }

    // ── GET USER BUNDLE PRICES ─────────────────────────────────────────────
    if (action === "get-user-prices") {
      const targetUserId = body.userId as string;
      if (!targetUserId) return json({ success: false, message: "User ID required" }, 400);
      const { data, error } = await supabase
        .from("user_bundle_prices")
        .select("bundle_id, custom_price")
        .eq("user_id", targetUserId);
      if (error) throw error;
      return json({ success: true, prices: data || [] });
    }

    // ── GET MASTER DATA ────────────────────────────────────────────────────
    if (action === "get-master-data") {
      const [bRes, uRes, sRes] = await Promise.all([
        supabase.from("bundles")
          .select("id, network, size, price, label")
          .eq("active", true)
          .order("network")
          .order("size"),
        supabase.from("users")
          .select("id, fullname, email, role")
          .order("fullname"),
        supabase.from("stores")
          .select("id, name, owner_id"),
      ]);

      if (bRes.error) throw bRes.error;
      if (sRes.error) throw sRes.error;

      const ownerIds = [...new Set((sRes.data || []).map((s: any) => s.owner_id).filter(Boolean))] as string[];
      let ownerMap: Record<string, { fullname: string; email: string }> = {};
      if (ownerIds.length > 0) {
        const { data: owners } = await supabase
          .from("users")
          .select("id, fullname, email")
          .in("id", ownerIds);
        (owners || []).forEach((o: any) => { ownerMap[o.id] = { fullname: o.fullname, email: o.email }; });
      }

      const stores = (sRes.data || []).map((s: any) => ({
        ...s,
        users: ownerMap[s.owner_id] || null,
      }));

      const filteredUsers = (uRes.data || []).filter(
        (u: any) => u.role !== "admin" && u.role !== "superadmin"
      );

      return json({
        success: true,
        bundles: bRes.data || [],
        users: filteredUsers,
        stores,
      });
    }

    // ── list-full ──────────────────────────────────────────────────────────
    if (action === "list-full") {
      const [usersRes, storesRes, ordersRes] = await Promise.all([
        supabase
          .from("users")
          .select("id, fullname, email, phone, role, store_unlocked, created_at, wallets(balance)")
          .order("created_at", { ascending: false }),
        supabase
          .from("stores")
          .select("id, name, owner_id, status"),
        supabase
          .from("adminorders")
          .select("userid, amount, status")
          .not("userid", "is", null)
          .in("status", ["completed", "processing", "pending"]),
      ]);

      if (usersRes.error) throw usersRes.error;

      const storesByOwnerId: Record<string, any> = {};
      (storesRes.data || []).forEach((s: any) => { storesByOwnerId[s.owner_id] = s; });

      const spendByUser: Record<string, { count: number; total: number }> = {};
      (ordersRes.data || []).forEach((o: any) => {
        if (!o.userid) return;
        if (!spendByUser[o.userid]) spendByUser[o.userid] = { count: 0, total: 0 };
        spendByUser[o.userid].count += 1;
        spendByUser[o.userid].total += parseFloat(o.amount || 0);
      });

      const users = (usersRes.data || []).map((u: any) => ({
        ...u,
        _store: storesByOwnerId[u.id] || null,
        _spend: spendByUser[u.id] || { count: 0, total: 0 },
      }));

      return json({ success: true, users });
    }

    // ── get-my-profile ─────────────────────────────────────────────────────
    if (action === "get-my-profile") {
      const { data: profile, error } = await supabase
        .from("users")
        .select("role, fullname")
        .eq("id", user.id)
        .single();
      if (error) throw error;
      return json({ success: true, profile });
    }

    // ── get-reseller-profits ───────────────────────────────────────────────
    if (action === "get-reseller-profits") {
      const { data: stores, error: storesErr } = await supabase
        .from("stores")
        .select("id, name, owner_id, status");
      if (storesErr) throw storesErr;
      if (!stores || stores.length === 0) return json({ success: true, owners: [] });

      const ownerIds = [...new Set(stores.map((s: any) => s.owner_id).filter(Boolean))] as string[];
      const { data: users, error: usersErr } = await supabase
        .from("users")
        .select("id, fullname, email, wallets(balance)")
        .in("id", ownerIds);
      if (usersErr) throw usersErr;
      if (!users || users.length === 0) return json({ success: true, owners: [] });

      const [bundlesRes, ubpRes] = await Promise.all([
        supabase.from("bundles").select("id, network, size, price").eq("active", true),
        supabase.from("user_bundle_prices").select("user_id, bundle_id, custom_price").in("user_id", ownerIds),
      ]);

      const bundleBaseMap: Record<string, number> = {};
      const bundleIdMap: Record<string, string>   = {};
      (bundlesRes.data || []).forEach((b: any) => {
        const key = b.network.toLowerCase() + "-" + b.size;
        bundleBaseMap[key] = parseFloat(b.price);
        bundleIdMap[key]   = b.id;
      });
      const customCostMap: Record<string, number> = {};
      (ubpRes.data || []).forEach((r: any) => {
        customCostMap[r.user_id + "-" + r.bundle_id] = parseFloat(r.custom_price);
      });

      const [ordersRes, withdrawalsRes] = await Promise.all([
        supabase
          .from("adminorders")
          .select("userid, amount, network, package_size, external_response")
          .or("order_reference.like.STORE-%,order_reference.like.GST-%,order_reference.like.PAY-%")
          .in("status", ["completed", "processing"])
          .in("external_response->>storeownerid" as any, ownerIds),
        // FIX (2026-05): user_note column deleted from withdrawal_requests.
        // All completed withdrawals for store owners are profit withdrawals —
        // no tag filtering needed. Also include 'pending' so in-flight
        // withdrawals are deducted, preventing double-spend.
        supabase
          .from("withdrawal_requests")
          .select("user_id, amount")
          .in("user_id", ownerIds)
          .in("status", ["completed", "pending"]),
      ]);

      const ordersByOwner: Record<string, any[]> = {};
      (ordersRes.data || []).forEach((o: any) => {
        const oid = o.external_response?.storeownerid;
        if (!oid) return;
        if (!ordersByOwner[oid]) ordersByOwner[oid] = [];
        ordersByOwner[oid].push(o);
      });

      const withdrawnByOwner: Record<string, number> = {};
      (withdrawalsRes.data || []).forEach((w: any) => {
        withdrawnByOwner[w.user_id] = (withdrawnByOwner[w.user_id] || 0) + parseFloat(w.amount || 0);
      });

      const owners = [];
     for (const u of (users || [])) {        const store      = stores.find((s: any) => s.owner_id === u.id);
        const orders     = ordersByOwner[u.id] || [];
        const totalSales = orders.length;

        let totalProfit = 0;
        for (const order of orders) {
          const ext          = order.external_response || {};
          const sellingPrice = parseFloat(ext.selling_price ?? order.amount ?? 0);

          // Resolve base cost — priority:
          // 1. Saved in external_response (most accurate — set at order time)
          // 2. User's custom bundle price (reseller-specific pricing)
          // 3. Global bundle base price (fallback)
          const rawSavedCost = ext.base_cost;
          const bundleKey    = (order.network || "").toLowerCase() + "-" + order.package_size;
          const bundleId     = bundleIdMap[bundleKey];

          let baseCost: number;
          if (rawSavedCost !== null && rawSavedCost !== undefined) {
            // Use the cost that was saved at order time — most accurate
            baseCost = parseFloat(rawSavedCost);
          } else if (bundleId && customCostMap[u.id + "-" + bundleId] != null) {
            baseCost = customCostMap[u.id + "-" + bundleId];
          } else {
            baseCost = bundleBaseMap[bundleKey] || 0;
          }

          // Use the saved profit if it's a valid number (including 0 for test orders).
          // Only fall back to calculation if profit was never saved.
          const savedProfit = (ext.profit !== undefined && ext.profit !== null)
            ? parseFloat(ext.profit)
            : null;

          let rowProfit: number;
          if (savedProfit !== null) {
            // Trust the saved profit — it was calculated correctly at order time.
            // Ignore negatives (test orders that were priced below cost).
            rowProfit = Math.max(0, savedProfit);
          } else {
            // No saved profit — calculate from cost
            rowProfit = Math.max(0, sellingPrice - baseCost);
          }

          totalProfit += rowProfit;
        }

      const totalWithdrawn  = withdrawnByOwner[u.id] || 0;
const availableProfit = Math.max(0, totalProfit - totalWithdrawn);

// Keep stores table synchronized
if (store) {
  await supabase
    .from("stores")
    .update({
      total_profit: Number(totalProfit.toFixed(2)),
      available_profit: Number(availableProfit.toFixed(2))
    })
    .eq("id", store.id);
}

owners.push({
  ...u,
  store,
  totalSales,
  totalProfit,
  totalWithdrawn,
  availableProfit
});
}
      owners.sort((a: any, b: any) => b.totalProfit - a.totalProfit);
      return json({ success: true, owners });
    }

    // ── reset-bundle-price ─────────────────────────────────────────────────
    if (action === "reset-bundle-price") {
      const targetUserId = body.userId as string;
      const bundleId     = body.bundleId as string;
      if (!targetUserId) return json({ success: false, message: "User ID required" }, 400);
      if (!bundleId)     return json({ success: false, message: "Bundle ID required" }, 400);

      const { error } = await supabase
        .from("user_bundle_prices")
        .delete()
        .eq("user_id", targetUserId)
        .eq("bundle_id", bundleId);

      if (error) throw error;

      await auditLog(supabase, user.id, "bundle_price_reset", { targetUserId, bundleId });
      return json({ success: true, message: "Price reset to base" });
    }

    // ── set-wallet-balance ─────────────────────────────────────────────────
    if (action === "set-wallet-balance") {
      const targetUserId  = body.userId        as string;
      const amount        = body.amount        as number;
      const balanceAction = body.balanceAction as string;
      const reason        = (body.reason as string) || `Admin manual ${balanceAction}`;

      if (!targetUserId)                            return json({ success: false, message: "User ID required" }, 400);
      if (typeof amount !== "number" || amount < 0) return json({ success: false, message: "Invalid amount" }, 400);
      if (!["add", "deduct", "set"].includes(balanceAction)) {
        return json({ success: false, message: "Invalid action. Must be: add, deduct, or set" }, 400);
      }

      const { data: target } = await supabase
        .from("users").select("role").eq("id", targetUserId).single();
      if (target?.role === "superadmin") {
        return json({ success: false, message: "Cannot modify superadmin balance" }, 403);
      }

      const { data, error } = await supabase.rpc("admin_set_wallet_balance", {
        p_user_id:  targetUserId,
        p_amount:   amount,
        p_action:   balanceAction,
        p_reason:   reason,
        p_admin_id: user.id,
      });

      if (error) throw error;
      if (!data?.success) return json({ success: false, message: data?.message || "Update failed" }, 400);

      await auditLog(supabase, user.id, "wallet_balance_update", {
        targetUserId, action: balanceAction, amount, reason, new_balance: data.new_balance,
      });

      return json({ success: true, message: "Balance updated", new_balance: data.new_balance });
    }

    return json({ success: false, message: `Unknown action: ${action}` }, 400);

  } catch (err) {
    console.error("admin-manage-users error:", err);
    return json({ success: false, message: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});