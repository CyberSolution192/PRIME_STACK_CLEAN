/**
 * admin-manage-checkers — Admin CRUD for checker_products (BECE/WASSCE/SHS
 * Placement pricing + catalog) and a monitoring view over checker_orders.
 * Same shape as admin-manage-bundles: called only via admin-proxy, which
 * forwards the service-role-verified internal secret + admin identity
 * headers. Never reachable directly from the browser.
 *
 * POST /functions/v1/admin-manage-checkers
 * Body: { action: "list-products"|"update-product"|"list-orders", ... }
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

async function verifyAdmin(req: Request) {
  const internalSecret = req.headers.get("x-internal-secret");
  if (!internalSecret || internalSecret !== Deno.env.get("ADMIN_INTERNAL_SECRET")) {
    return { user: null };
  }
  const userId = req.headers.get("x-admin-user-id");
  const role = req.headers.get("x-admin-role");
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
    admin_id: adminId,
    action,
    details,
    created_at: new Date().toISOString(),
  }).then(({ error }: { error: any }) => {
    if (error) console.warn("Audit log insert failed (non-fatal):", error.message);
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { user } = await verifyAdmin(req);
  if (!user) return json({ success: false, message: "Forbidden: admin access required" }, 403);

  let body: {
    action?: string;
    productId?: string;
    product?: Record<string, unknown>;
    status?: string;
    limit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  const { action } = body;

  try {
    switch (action) {
      // ── LIST PRODUCTS ─────────────────────────────────────────────────
      case "list-products": {
        const { data, error } = await supabase
          .from("checker_products")
          .select("*")
          .order("name");
        if (error) throw error;
        return json({ success: true, products: data });
      }

      // ── UPDATE PRODUCT (pricing, active flag, dbh_category, etc.) ──────
      case "update-product": {
        const { productId, product } = body;
        if (!productId || !product) {
          return json({ success: false, message: "productId and product are required" }, 400);
        }

        // Whitelist editable fields — never let the client set id/created_at.
        const allowed = [
          "name", "description", "official_check_url", "requires_index_number",
          "cost_price", "selling_price", "dbh_category", "is_active",
        ];
        const updatePayload: Record<string, unknown> = {};
        for (const key of allowed) {
          if (key in product) updatePayload[key] = (product as any)[key];
        }
        if (Object.keys(updatePayload).length === 0) {
          return json({ success: false, message: "No editable fields provided" }, 400);
        }

        const { data, error } = await supabase
          .from("checker_products")
          .update(updatePayload)
          .eq("id", productId)
          .select()
          .single();
        if (error) throw error;

        await auditLog(supabase, user.id, "checker_product_update", { productId, updatePayload });
        return json({ success: true, product: data });
      }

      // ── LIST ORDERS (monitoring/reconciliation) ─────────────────────────
      case "list-orders": {
        const limit = Math.min(body.limit || 50, 200);
        let query = supabase
          .from("checker_orders")
          .select("order_reference, user_id, status, amount, index_number, serial_number, pin, dbh_reference, created_at, checker_products(code, name)")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (body.status) query = query.eq("status", body.status);

        const { data, error } = await query;
        if (error) throw error;
        return json({ success: true, orders: data });
      }

      // ── RESOLVE / REFUND AN ORDER ─────────────────────────────────────
      // resolution: "complete" (admin recovered/confirmed credentials for a
      // manual_review order) or "refund" (credit the customer back — valid
      // for a manual_review order OR a completed order being disputed).
      case "resolve-manual-review": {
        const { orderReference, resolution, serial_number, pin, exam_date, results_link } = body as any;
        if (!orderReference || !["complete", "refund"].includes(resolution)) {
          return json({ success: false, message: "orderReference and a valid resolution ('complete'|'refund') are required" }, 400);
        }

        const { data: order, error: orderError } = await supabase
          .from("checker_orders")
          .select("id, order_reference, user_id, amount, status, details")
          .eq("order_reference", orderReference)
          .single();

        if (orderError || !order) return json({ success: false, message: "Order not found" }, 404);

        if (resolution === "complete" && order.status !== "manual_review") {
          return json({ success: false, message: `Order is '${order.status}' — can only manually complete a manual_review order` }, 400);
        }
        if (resolution === "refund" && !["manual_review", "completed"].includes(order.status)) {
          return json({ success: false, message: `Order is '${order.status}' — refund only applies to a manual_review or completed order` }, 400);
        }

        if (resolution === "complete") {
          if (!serial_number || !pin) {
            return json({ success: false, message: "serial_number and pin are required to complete manually" }, 400);
          }

          const { data: updated, error: updateError } = await supabase
            .from("checker_orders")
            .update({
              status: "completed",
              serial_number,
              pin,
              details: { ...(order.details as object || {}), exam_date, results_link, resolved_by: user.id, resolved_at: new Date().toISOString() },
            })
            .eq("id", order.id)
            .select()
            .single();
          if (updateError) throw updateError;

          await auditLog(supabase, user.id, "checker_order_resolved_complete", { orderReference });
          return json({ success: true, order: updated });
        }

        // resolution === "refund"
        const { data: wallet, error: walletError } = await supabase
          .from("wallets")
          .select("id, balance, version")
          .eq("user_id", order.user_id)
          .single();
        if (walletError || !wallet) return json({ success: false, message: "Customer wallet not found" }, 400);

        const newBalance = parseFloat((parseFloat(wallet.balance as unknown as string) + parseFloat(order.amount as unknown as string)).toFixed(2));
        const { error: creditError } = await supabase
          .from("wallets")
          .update({ balance: newBalance, version: wallet.version + 1, updated_at: new Date().toISOString() })
          .eq("id", wallet.id)
          .eq("version", wallet.version);
        if (creditError) return json({ success: false, message: "Wallet credit failed — retry" }, 500);

        const { data: updated, error: updateError } = await supabase
          .from("checker_orders")
          .update({
            status: "refunded",
            details: { ...(order.details as object || {}), resolved_by: user.id, resolved_at: new Date().toISOString() },
          })
          .eq("id", order.id)
          .select()
          .single();
        if (updateError) throw updateError;

        await auditLog(supabase, user.id, "checker_order_resolved_refund", { orderReference, amount: order.amount });
        return json({ success: true, order: updated });
      }

      default:
        return json({ success: false, message: "Unknown action" }, 400);
    }
  } catch (error) {
    console.error("admin-manage-checkers error:", error);
    return json({ success: false, message: error instanceof Error ? error.message : "Internal error" }, 500);
  }
});