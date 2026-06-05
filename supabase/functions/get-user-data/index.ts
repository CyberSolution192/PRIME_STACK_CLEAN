// ============================================================
// supabase/functions/get-user-data/index.ts — v5
// ============================================================
// KEY CHANGES from v4:
//
// BUG FIX — store-stats: user_note column was deleted from
//   withdrawal_requests table (2026-05 admin-manage-users patch).
//   v4 still selected and filtered on user_note, causing:
//     1. The .select() includes a column that no longer exists →
//        the query may return empty data or error silently, so
//        totalWithdrawn and pendingBalance always show 0.
//     2. Even if the column existed, completedTagged would be
//        empty for users whose withdrawals predate the [profit]
//        tag, causing the fallback to count ALL withdrawals —
//        but that only works coincidentally, not by design.
//
//   FIX: Remove user_note from both .select() calls and remove
//   the tag-based filtering entirely. All completed/pending
//   withdrawal_requests for store owners are profit withdrawals
//   by definition (only store owners can withdraw profits).
//   This matches the logic already deployed in admin-manage-users
//   (get-reseller-profits action, 2026-05 patch) and in
//   submit-withdrawal (which tags rows with '[profit]' in user_note,
//   but we cannot rely on that after the column deletion).
//
// NO other logic changed. All other sections (profile, transactions,
// orders, store-orders, withdrawals, bundles, store, store-prices)
// are identical to v4.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // ── Auth: always use getUser() — verifies JWT server-side ──────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, message: "Unauthorized" }, 401);

  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return json({ success: false, message: "Invalid or expired token" }, 401);

  // ── Read params from query string (proxy appends __query as ?section=...) ──
  const url = new URL(req.url);
  const section  = url.searchParams.get("section") || "profile";
  const page     = parseInt(url.searchParams.get("page") || "1");
  const pageSize = Math.min(parseInt(url.searchParams.get("pageSize") || "20"), 200);
  const offset   = (page - 1) * pageSize;

  try {
    switch (section) {

      case "profile": {
        const [profileRes, walletRes] = await Promise.all([
          supabase.from("users")
            .select("id, fullname, email, phone, role, store_unlocked, created_at")
            .eq("id", user.id)
            .single(),
          supabase.from("wallets")
            .select("balance")
            .eq("user_id", user.id)
            .single(),
        ]);

        if (profileRes.error) throw profileRes.error;

        return json({
          success: true,
          profile: profileRes.data,
          balance: walletRes.data?.balance ?? 0,
        });
      }

      case "transactions": {
        const { data, error, count } = await supabase
          .from("transactions")
          .select("id, type, amount, description, status, created_at", { count: "exact" })
          .eq("userid", user.id)
          .order("created_at", { ascending: false })
          .range(offset, offset + pageSize - 1);

        if (error) {
          console.error("get-user-data transactions error:", JSON.stringify(error));
          throw error;
        }
        return json({ success: true, transactions: data, total: count, page, pageSize });
      }

      case "orders": {
        const { data, error, count } = await supabase
          .from("adminorders")
          .select(
            "id, order_reference, network, package_size, recipient, amount, status, created_at",
            { count: "exact" }
          )
          .eq("userid", user.id)
          .order("created_at", { ascending: false })
          .range(offset, offset + pageSize - 1);

        if (error) throw error;
        return json({ success: true, orders: data, total: count, page, pageSize });
      }

      case "store-orders": {
        const statusFilter = url.searchParams.get("status") || "";

        let query = supabase
          .from("adminorders")
          .select(
            "id, order_reference, network, package_size, recipient, amount, status, created_at",
            { count: "exact" }
          )
          .or("order_reference.like.STORE-%,order_reference.like.GST-%,order_reference.like.PAY-%")
          .filter("external_response->>storeownerid", "eq", user.id)
          .order("created_at", { ascending: false });

        if (statusFilter && statusFilter !== "all") {
          query = query.eq("status", statusFilter);
        }

        query = query.range(0, 199);

        const { data, error, count } = await query;
        if (error) throw error;
        return json({ success: true, orders: data ?? [], total: count ?? 0 });
      }

      case "withdrawals": {
        // Withdrawals section kept for history display — store profit withdrawals only
        const { data, error } = await supabase
          .from("withdrawal_requests")
          .select("id, amount, fee, recipient_account, network, status, created_at, admin_note, rejection_reason, processed_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) throw error;
        return json({ success: true, withdrawals: data });
      }

      case "bundles": {
        const [bundlesRes, ubpRes] = await Promise.all([
          supabase.from("bundles")
            .select("id, network, size, price")
            .eq("active", true)
            .order("network")
            .order("size"),
          supabase.from("user_bundle_prices")
            .select("bundle_id, custom_price")
            .eq("user_id", user.id),
        ]);

        if (bundlesRes.error) throw bundlesRes.error;

        const customPriceMap: Record<string, number> = {};
        (ubpRes.data || []).forEach((r: any) => {
          customPriceMap[r.bundle_id] = parseFloat(r.custom_price);
        });

        const bundles = (bundlesRes.data || []).map((b: any) => ({
          ...b,
          effective_price: customPriceMap[b.id] ?? parseFloat(b.price),
        }));

        return json({ success: true, bundles });
      }

      case "store-stats": {
        // ── BUG FIX (v5) ─────────────────────────────────────────────────────
        // The user_note column was deleted from withdrawal_requests (2026-05).
        // v4 selected user_note and filtered on it to identify "profit"
        // withdrawals — but now the column does not exist, so the select
        // silently fails and both totalWithdrawn and pendingBalance return 0.
        //
        // FIX: Remove user_note from all withdrawal queries. All withdrawals
        // for store owners are profit withdrawals (gate enforced server-side in
        // submit-withdrawal). Count every completed withdrawal as "withdrawn"
        // and every pending withdrawal as "pending balance". This is identical
        // to the logic in admin-manage-users get-reseller-profits (2026-05).
        // ─────────────────────────────────────────────────────────────────────
        const [ordersRes, bundlesRes, ubpRes, completedWithdrawalsRes, pendingWithdrawalsRes] = await Promise.all([
          supabase.from("adminorders")
            .select("amount, network, package_size, external_response")
            .or("order_reference.like.STORE-%,order_reference.like.GST-%,order_reference.like.PAY-%")
            .in("status", ["completed", "processing"])
            .filter("external_response->>storeownerid", "eq", user.id),
          supabase.from("bundles").select("id, network, size, price").eq("active", true),
          supabase.from("user_bundle_prices")
            .select("bundle_id, custom_price").eq("user_id", user.id),

          // FIX: select only "amount" — user_note no longer exists.
          // All completed withdrawals for this user count as profit withdrawals.
          supabase.from("withdrawal_requests")
            .select("amount")
            .eq("user_id", user.id)
            .eq("status", "completed"),

          // FIX: same — select only "amount", count all pending withdrawals.
          supabase.from("withdrawal_requests")
            .select("amount")
            .eq("user_id", user.id)
            .eq("status", "pending"),
        ]);

        const bundleBaseMap: Record<string, number> = {};
        const bundleIdMap: Record<string, string> = {};
        (bundlesRes.data || []).forEach((b: any) => {
          const key = b.network.toLowerCase() + "-" + b.size;
          bundleBaseMap[key] = parseFloat(b.price);
          bundleIdMap[key] = b.id;
        });

        const customCostMap: Record<string, number> = {};
        (ubpRes.data || []).forEach((r: any) => {
          customCostMap[r.bundle_id] = parseFloat(r.custom_price);
        });

        let totalRevenue = 0;
        let totalEarned  = 0;
        for (const order of (ordersRes.data || [])) {
          const ext = order.external_response || {};
          const sellingPrice = parseFloat(String(ext.selling_price ?? order.amount ?? 0));
          totalRevenue += sellingPrice;

          const rawSavedCost = ext.base_cost;
          const bundleKey    = (order.network || "").toLowerCase() + "-" + order.package_size;
          const bundleId     = bundleIdMap[bundleKey];

          let baseCost: number;
          if (rawSavedCost !== null && rawSavedCost !== undefined) {
            baseCost = parseFloat(String(rawSavedCost));
          } else if (bundleId && customCostMap[bundleId] != null) {
            baseCost = customCostMap[bundleId];
          } else {
            baseCost = bundleBaseMap[bundleKey] || 0;
          }

          const savedProfit = (ext.profit !== undefined && ext.profit !== null)
            ? parseFloat(String(ext.profit))
            : null;

          const rowProfit = savedProfit !== null
            ? Math.max(0, savedProfit)
            : Math.max(0, sellingPrice - baseCost);

          totalEarned += rowProfit;
        }

        // FIX: No user_note filtering — sum every completed withdrawal.
        // (All completed withdrawals for a store owner ARE profit withdrawals.)
        const totalWithdrawn = (completedWithdrawalsRes.data || [])
          .reduce((sum: number, w: any) => sum + parseFloat(w.amount || 0), 0);

        // FIX: No user_note filtering — sum every pending withdrawal.
        const pendingBalance = (pendingWithdrawalsRes.data || [])
          .reduce((sum: number, w: any) => sum + parseFloat(w.amount || 0), 0);

        const availableProfits = Math.max(0, totalEarned - totalWithdrawn - pendingBalance);

        return json({
          success: true,
          totalRevenue,
          totalEarned,
          totalWithdrawn,
          pendingBalance,
          availableProfits,
          orderCount: (ordersRes.data || []).length,
        });
      }

      case "store": {
        const { data, error } = await supabase
          .from("stores")
          .select("id, name, slug, short_code, status, theme_color, support_phone, whatsapp_support, whatsapp_group, updated_at")
          .eq("owner_id", user.id)
          .maybeSingle();

        if (error) throw error;
        return json({ success: true, store: data });
      }

      case "store-prices": {
        const storeRes = await supabase
          .from("stores")
          .select("id")
          .eq("owner_id", user.id)
          .maybeSingle();

        if (storeRes.error || !storeRes.data) {
          return json({ success: true, prices: [] });
        }

        const { data, error } = await supabase
          .from("store_bundle_prices")
          .select("network, size, base_price, store_price, active")
          .eq("store_id", storeRes.data.id);

        if (error) throw error;
        return json({ success: true, prices: data });
      }

      default:
        return json({ success: false, message: `Unknown section: ${section}` }, 400);
    }
  } catch (err) {
    console.error("get-user-data error:", err);
    return json({ success: false, message: "Internal server error" }, 500);
  }
});