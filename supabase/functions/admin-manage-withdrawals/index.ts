/**
 * admin-manage-withdrawals — v3
 *
 * CHANGE from v1: removed user_note column (deleted from DB, always null).
 * The isProfitWithdrawal check that depended on user_note is also removed —
 * all mark-sent flows now debit the wallet uniformly.
 *
 * CHANGE from v2: recipient_name added to list select so the admin card
 * can display the account holder name the user submitted at withdrawal time.
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
  const internalSecret = req.headers.get("x-internal-secret");
  if (!internalSecret || internalSecret !== Deno.env.get("ADMIN_INTERNAL_SECRET")) {
    return { user: null };
  }
  const userId = req.headers.get("x-admin-user-id");
  const role   = req.headers.get("x-admin-role");
  if (!userId || !role) return { user: null };
  if (!["admin", "superadmin"].includes(role)) return { user: null };
  return { user: { id: userId } };
}

async function auditLog(
  supabase: ReturnType<typeof createClient>,
  adminId: string,
  action: string,
  details: Record<string, unknown>
) {
  await supabase.from("admin_audit_log").insert({
    admin_id: adminId, action, details,
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
    // ── LIST ──────────────────────────────────────────────────────────────────
    if (action === "list") {
      const status = body.status as string | undefined;
      let query = supabase
        .from("withdrawal_requests")
        .select("id, user_id, amount, fee, recipient_account, recipient_name, network, status, method, created_at, processed_at, processed_by")
        .order("created_at", { ascending: false })
        .limit(100);

      if (status) query = query.eq("status", status);

      const { data, error } = await query;
      if (error) throw error;

      const userIds = [...new Set((data || []).map((w: any) => w.user_id).filter(Boolean))];
      let userMap: Record<string, string> = {};
      if (userIds.length > 0) {
        const { data: users } = await supabase
          .from("users").select("id, fullname, email").in("id", userIds);
        (users || []).forEach((u: any) => {
          userMap[u.id] = u.fullname || u.email;
        });
      }

      const enriched = (data || []).map((w: any) => ({
        ...w,
        user_name: userMap[w.user_id] || "Unknown",
      }));

      return json({ success: true, withdrawals: enriched });
    }

    // ── APPROVE / REJECT ─────────────────────────────────────────────────────
    if (action === "approve" || action === "reject") {
      const id = body.id as string;
      if (!id) return json({ success: false, message: "Withdrawal ID required" }, 400);

      const { data: current } = await supabase
        .from("withdrawal_requests")
        .select("status, amount, user_id")
        .eq("id", id)
        .single();

      if (!current) return json({ success: false, message: "Withdrawal not found" }, 404);

      const allowed: Record<string, string[]> = {
        "approve": ["pending"],
        "reject":  ["pending", "approved"],
      };

      if (!allowed[action].includes(current.status)) {
        return json({
          success: false,
          message: `Cannot ${action} a withdrawal in '${current.status}' status`,
        }, 400);
      }

      // ── Re-verify available profit before APPROVING ─────────────────────
      // This is the checkpoint that actually matters for preventing
      // overpayment: it runs BEFORE the admin sends any real money (that
      // happens after approval, outside this system, via the admin's own
      // MoMo app — by the time mark-sent/admin_debit_wallet runs, the real
      // payout has already gone out and can't be un-sent). Recomputes the
      // same profit calculation submit-withdrawal used, live, rather than
      // trusting the amount stored on the row at request time — protects
      // against the underlying figures having changed since, or the
      // now-closed submission race having let through more pending
      // withdrawals than were actually available. reject is exempt — it
      // never risks money leaving.
      if (action === "approve") {
        const [ordersRes, bundlesRes, ubpRes, completedWithdrawalsRes, pendingWithdrawalsRes] =
          await Promise.all([
            supabase
              .from("adminorders")
              .select("amount, network, package_size, external_response")
              .or("order_reference.like.STORE-%,order_reference.like.GST-%,order_reference.like.PAY-%")
              .eq("status", "completed")
              .filter("external_response->>storeownerid", "eq", current.user_id),
            supabase.from("bundles").select("id, network, size, price").eq("active", true),
            supabase.from("user_bundle_prices").select("bundle_id, custom_price").eq("user_id", current.user_id),
            supabase.from("withdrawal_requests").select("amount")
              .eq("user_id", current.user_id).eq("status", "completed"),
            // Exclude the row being approved from its own "already pending"
            // total — it's the one we're about to approve.
            supabase.from("withdrawal_requests").select("amount")
              .eq("user_id", current.user_id).eq("status", "pending").neq("id", id),
          ]);

        const bundleBaseMap: Record<string, number> = {};
        const bundleIdMap: Record<string, string>   = {};
        (bundlesRes.data || []).forEach((b: any) => {
          const key = b.network.toLowerCase() + '-' + b.size;
          bundleBaseMap[key] = parseFloat(b.price);
          bundleIdMap[key]   = b.id;
        });

        const customCostMap: Record<string, number> = {};
        (ubpRes.data || []).forEach((r: any) => { customCostMap[r.bundle_id] = parseFloat(r.custom_price); });

        let totalEarned = 0;
        for (const order of (ordersRes.data || [])) {
          const ext          = order.external_response || {};
          const sellingPrice = parseFloat(String(ext.selling_price ?? order.amount ?? 0));
          const rawSavedCost = ext.base_cost;
          const bundleKey    = (order.network || '').toLowerCase() + '-' + order.package_size;
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

          totalEarned += savedProfit !== null
            ? Math.max(0, savedProfit)
            : Math.max(0, sellingPrice - baseCost);
        }

        const totalWithdrawn = (completedWithdrawalsRes.data || [])
          .reduce((s: number, w: any) => s + parseFloat(w.amount || 0), 0);
        const otherPending = (pendingWithdrawalsRes.data || [])
          .reduce((s: number, w: any) => s + parseFloat(w.amount || 0), 0);
        const availableProfits = Math.max(0, totalEarned - totalWithdrawn - otherPending);

        if (parseFloat(String(current.amount)) > availableProfits) {
          await auditLog(supabase, user.id, "withdrawal_approve_blocked_insufficient_profit", {
            withdrawalId: id,
            userId: current.user_id,
            requestedAmount: current.amount,
            actualAvailableProfit: availableProfits,
          });
          return json({
            success: false,
            message: `Cannot approve: this user's current available profit (GH₵${availableProfits.toFixed(2)}) no longer covers this withdrawal (GH₵${parseFloat(String(current.amount)).toFixed(2)}). Reject it or ask them to resubmit.`,
          }, 400);
        }
      }

      const newStatus = action === "approve" ? "approved" : "rejected";

      const { error } = await supabase
        .from("withdrawal_requests")
        .update({
          status: newStatus,
          processed_by: user.id,
          processed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (error) throw error;

      await auditLog(supabase, user.id, `withdrawal_${action}`, {
        withdrawalId: id,
        userId: current.user_id,
        amount: current.amount,
        fromStatus: current.status,
        toStatus: newStatus,
      });

      console.log(`✅ Withdrawal ${id} → ${newStatus} by admin ${user.id}`);
      return json({ success: true, message: `Withdrawal ${action}d successfully` });
    }

    // ── MARK-SENT ─────────────────────────────────────────────────────────────
    if (action === "mark-sent") {
      const id = body.id as string;
      if (!id) return json({ success: false, message: "Withdrawal ID required" }, 400);

      const { data: current, error: fetchErr } = await supabase
        .from("withdrawal_requests")
        .select("id, user_id, status, amount, fee")
        .eq("id", id)
        .single();

      if (fetchErr || !current) {
        return json({ success: false, message: "Withdrawal not found" }, 404);
      }

      if (!["approved", "processing"].includes(current.status)) {
        return json({
          success: false,
          message: `Cannot mark as sent from status: '${current.status}'`,
        }, 400);
      }

      // Step 1 — approved → processing
      if (current.status === "approved") {
        // CRITICAL: .select() + row-count check, not just error-check.
        // A conditional UPDATE that matches zero rows is NOT an error in
        // Postgres — it succeeds silently with no rows changed. Without
        // checking the actual row count here, two near-simultaneous
        // mark-sent calls (double-click, slow network, two admins) would
        // BOTH proceed past this guard and BOTH debit the wallet — the
        // second one debiting for a payout that was already sent.
        const { data: transitioned, error: procErr } = await supabase
          .from("withdrawal_requests")
          .update({
            status: "processing",
            processed_by: user.id,
            processed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", id)
          .eq("status", "approved")
          .select("id");

        if (procErr) {
          console.error("Failed to set status=processing:", procErr);
          return json({ success: false, message: procErr.message }, 500);
        }

        if (!transitioned || transitioned.length === 0) {
          // Someone else's request already moved this out of 'approved' —
          // do NOT proceed to debit the wallet a second time.
          return json({
            success: false,
            message: "This withdrawal was already being processed by another request. No duplicate payout was made.",
          }, 409);
        }

        // Step 2 — debit wallet (soft-fail: money already sent, log and continue)
        const totalDebit = Number(current.amount) + Number(current.fee ?? 0);
        const { error: walletErr } = await supabase.rpc("admin_debit_wallet", {
          _user_id: current.user_id,
          _amount:  totalDebit,
        });

        if (walletErr) {
          console.error("Wallet debit failed (soft):", walletErr.message);
          await auditLog(supabase, user.id, "withdrawal_wallet_debit_failed", {
            withdrawalId: id,
            userId: current.user_id,
            amount: totalDebit,
            error: walletErr.message,
          });
          // Continue — do not return early.
        }
      }

      // Step 3 — processing → completed
      const { data: completedRows, error: completeErr } = await supabase
        .from("withdrawal_requests")
        .update({
          status: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("status", "processing")
        .select("id");

      if (completeErr) {
        console.error("Failed to set status=completed:", completeErr);
        return json({ success: false, message: completeErr.message }, 500);
      }

      if (!completedRows || completedRows.length === 0) {
        // Already completed by another request — the wallet debit above is
        // still correctly guarded (it only ever runs once), this just
        // avoids logging a second misleading "completed" audit entry.
        return json({ success: true, message: "Withdrawal was already marked as completed." });
      }

      await auditLog(supabase, user.id, "withdrawal_mark-sent", {
        withdrawalId: id,
        userId: current.user_id,
        amount: current.amount,
        fromStatus: current.status,
        toStatus: "completed",
      });

      console.log(`✅ Withdrawal ${id} → completed by admin ${user.id}`);
      return json({ success: true, message: "Withdrawal marked as completed" });
    }

    return json({ success: false, message: `Unknown action: ${action}` }, 400);

  } catch (err) {
    console.error("admin-manage-withdrawals error:", err);
    return json({ success: false, message: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});