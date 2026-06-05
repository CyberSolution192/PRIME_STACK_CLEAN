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
        const { error: procErr } = await supabase
          .from("withdrawal_requests")
          .update({
            status: "processing",
            processed_by: user.id,
            processed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", id)
          .eq("status", "approved");

        if (procErr) {
          console.error("Failed to set status=processing:", procErr);
          return json({ success: false, message: procErr.message }, 500);
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
      const { error: completeErr } = await supabase
        .from("withdrawal_requests")
        .update({
          status: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("status", "processing");

      if (completeErr) {
        console.error("Failed to set status=completed:", completeErr);
        return json({ success: false, message: completeErr.message }, 500);
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