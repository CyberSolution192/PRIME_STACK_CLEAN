/**
 * admin-manage-orders — MERGED (base + 2026-04 patch + 2026-05 DataBossHub patch + 2026-05 Site Lock patch)
 *
 * Actions:
 *   list                   → paginated order list with optional prefix/status/network filter
 *   update-status          → change order status
 *   create-manual          → create a manual order (guest/store/user)
 *   get-stats              → basic order counts
 *   get-dashboard-stats    → full dashboard stats (revenue, orders by type, users)
 *   get-setting            → read a system setting
 *   set-setting            → write a system setting
 *   get-manual-deposits    → pending manual deposits
 *   get-paystack-history   → recent Paystack verifications
 *   get-orphaned-payments  → unresolved orphans, unprocessed webhook events, legacy orphaned payments
 *   get-order-prefill      → recover phone/network/size from a payment reference
 *   resolve-orphan         → mark a webhook orphan as resolved
 *   get-order              → replaces duplicate direct adminorders reads in openOrderDetails()
 *   approve-manual-deposit → replaces direct admin_approve_manual_deposit RPC
 *   decline-manual-deposit → replaces direct admin_decline_manual_deposit RPC
 *   get-analytics          → sales analytics: stat cards, daily chart, network breakdown
 *   export-csv             → export orders or revenue summary as CSV string (browser triggers download)
 *   export-pdf             → returns structured report JSON; client renders PDF via jsPDF (no Deno binary deps)
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
    admin_id: adminId,
    action,
    details,
    created_at: new Date().toISOString(),
  }).then(({ error }) => {
    if (error) console.warn("Audit log failed:", error.message);
  });
}

const ALLOWED_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "manual_review",
  "failed_provider",
  "processing_locked",
];
const PREFIX_MAP: Record<string, string> = {
  GST:   "GST-%",
  STORE: "STORE-%",
  TXN:   "TXN-%",
};

// ── Site lock value validator ─────────────────────────────────────────────────
// Site lock values are JSON strings (not simple enums). We validate they are
// parseable JSON with the expected shape before writing to the DB.
function validateSiteLockValue(raw: string): { valid: boolean; error?: string } {
  try {
    const v = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return { valid: false, error: "Value must be a JSON object" };
    if (typeof v.locked !== "boolean")        return { valid: false, error: "'locked' field must be boolean" };
    if (v.locked) {
      if (!v.title   || typeof v.title   !== "string") return { valid: false, error: "'title' is required when locking" };
      if (!v.message || typeof v.message !== "string") return { valid: false, error: "'message' is required when locking" };
    }
    const allowedIcons = ["clock", "wrench", "ban", "bullhorn"];
    if (v.icon && !allowedIcons.includes(v.icon)) {
      return { valid: false, error: `'icon' must be one of: ${allowedIcons.join(", ")}` };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Value is not valid JSON" };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

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

    // ── LIST orders (paginated) ────────────────────────────────────────────
    if (action === "list") {
      const page       = Math.max(1, parseInt(String(body.page     || 1)));
      const pageSize   = Math.min(500, Math.max(1, parseInt(String(body.pageSize || 20))));
      const offset     = (page - 1) * pageSize;
      const statusFilter  = body.status  as string | undefined;
      const networkFilter = body.network as string | undefined;
      const search        = body.search  as string | undefined;
      const prefixFilter  = body.prefixFilter as string | undefined;
      const likePattern   = prefixFilter ? PREFIX_MAP[prefixFilter.toUpperCase()] : undefined;

      if (prefixFilter && !likePattern) {
        return json({
          success: false,
          message: `Unknown prefixFilter '${prefixFilter}'. Allowed: ${Object.keys(PREFIX_MAP).join(", ")}`,
        }, 400);
      }

      let query = supabase
        .from("adminorders")
        .select(
          "id, order_reference, userid, network, package_size, recipient, amount, status, created_at, description, external_response, users(fullname, email, phone)",
          { count: "exact" }
        )
        .order("created_at", { ascending: false })
        .range(offset, offset + pageSize - 1);

      if (likePattern) query = query.like("order_reference", likePattern);
      if (statusFilter && ALLOWED_STATUSES.includes(statusFilter)) query = query.eq("status", statusFilter);
      if (networkFilter) query = query.eq("network", networkFilter.toLowerCase());
      query = query.neq("status", "payment_pending");
      if (search) query = query.or(`order_reference.ilike.%${search}%,recipient.ilike.%${search}%`);

      const { data, error, count } = await query;
      if (error) throw error;

      // Enrich STORE- orders with store owner name + phone
      let orders: any[] = data || [];
      const isStoreQuery = prefixFilter?.toUpperCase() === "STORE" || !prefixFilter;
      if (isStoreQuery) {
        const ownerIds = [
          ...new Set(
            orders
              .map((o: any) => o.external_response?.storeownerid)
              .filter((id: any) => id && typeof id === "string" && id.length > 10)
          ),
        ] as string[];

        if (ownerIds.length > 0) {
          const { data: owners } = await supabase
            .from("users")
            .select("id, fullname, phone, email")
            .in("id", ownerIds);

          const ownerMap: Record<string, { fullname: string; phone: string; email: string }> = {};
          for (const o of owners || []) {
            ownerMap[o.id] = { fullname: o.fullname, phone: o.phone, email: o.email };
          }

          orders = orders.map((o: any) => {
            const sid = o.external_response?.storeownerid;
            if (sid && ownerMap[sid]) {
              return { ...o, store_owner: ownerMap[sid] };
            }
            return o;
          });
        }
      }

      return json({ success: true, orders, total: count, page, pageSize });
    }

    // ── UPDATE STATUS ──────────────────────────────────────────────────────
    if (action === "update-status") {
      const orderId   = body.orderId  as string;
      const newStatus = body.status   as string;

      if (!orderId || typeof orderId !== "string") return json({ success: false, message: "Order ID required" }, 400);
      if (!newStatus || !ALLOWED_STATUSES.includes(newStatus)) {
        return json({ success: false, message: `Invalid status. Must be one of: ${ALLOWED_STATUSES.join(", ")}` }, 400);
      }

      const { data: current } = await supabase
        .from("adminorders").select("status, order_reference, payment_reference, external_response").eq("id", orderId).single();
      if (!current) return json({ success: false, message: "Order not found" }, 404);

      if (current.status === "completed" && !["failed"].includes(newStatus)) {
        return json({ success: false, message: "Completed orders can only be moved to: failed" }, 400);
      }

      const { error } = await supabase
        .from("adminorders")
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq("id", orderId);
      if (error) throw error;

      await auditLog(supabase, user.id, "order_status_update", {
        orderId, reference: current.order_reference, fromStatus: current.status, toStatus: newStatus,
      });

      // Sync the matching transactions row so it reflects the true final state.
      if (newStatus === "completed" || newStatus === "failed") {
        await supabase
          .from("transactions")
          .update({ status: newStatus, updated_at: new Date().toISOString() })
          .filter("details->>order_id", "eq", current.order_reference)
          .then(({ error: e }) => { if (e) console.warn("tx sync link1:", e.message); });

        if (current.payment_reference) {
          await supabase
            .from("transactions")
            .update({ status: newStatus, updated_at: new Date().toISOString() })
            .filter("details->>order_id", "eq", current.payment_reference)
            .then(({ error: e }) => { if (e) console.warn("tx sync link2:", e.message); });
        }

        const extPaymentRef = current.external_response?.payment_reference;
        if (extPaymentRef && extPaymentRef !== current.payment_reference) {
          await supabase
            .from("transactions")
            .update({ status: newStatus, updated_at: new Date().toISOString() })
            .filter("details->>order_id", "eq", extPaymentRef)
            .then(({ error: e }) => { if (e) console.warn("tx sync link3:", e.message); });
        }
      }

      // When an order completes, also update store totals and guest_orders.
      if (newStatus === "completed") {
        const { data: completedOrder } = await supabase
          .from("adminorders")
          .select("amount, order_reference, external_response")
          .eq("id", orderId)
          .single();

        if (completedOrder) {
          const orderAmount  = Math.abs(parseFloat(completedOrder.amount) || 0);
          const storeOwnerId = completedOrder.external_response?.storeownerid;

          if (storeOwnerId) {
            await supabase.rpc("increment_store_totals", {
              p_owner_id: storeOwnerId,
              p_amount:   orderAmount,
            }).then(({ error: rpcErr }) => {
              if (rpcErr) console.warn("increment_store_totals (non-fatal):", rpcErr.message);
            });
          }

          await supabase
            .from("guest_orders")
            .update({
              status:       "completed",
              fulfilled_at: new Date().toISOString(),
              updated_at:   new Date().toISOString(),
            })
            .eq("order_reference", completedOrder.order_reference)
            .then(({ error: goErr }) => {
              if (goErr) console.warn("guest_orders fulfilled_at sync (non-fatal):", goErr.message);
            });
        }
      }

      return json({ success: true, message: "Order status updated" });
    }

    // ── CREATE MANUAL ORDER ────────────────────────────────────────────────
    if (action === "create-manual") {
      const phone     = String(body.phone   || "").trim();
      const network   = String(body.network || "").toLowerCase();
      const size      = parseInt(String(body.size   || 0));
      const amount    = parseFloat(String(body.amount || 0));
      const reference = String(body.reference || "").trim();
      const orderType = (body.orderType as string || "guest").toLowerCase();

      const PREFIX_FOR_TYPE: Record<string, string> = { guest: "GST", store: "STORE", user: "TXN" };
      const orderPrefix = PREFIX_FOR_TYPE[orderType] ?? "GST";

      if (!/^[0-9]{10}$/.test(phone))                         return json({ success: false, message: "Enter a valid 10-digit phone number" }, 400);
      if (!["mtn", "telecel", "airteltigo"].includes(network)) return json({ success: false, message: "Invalid network" }, 400);
      if (!size || size <= 0 || size > 1000)                   return json({ success: false, message: "Invalid bundle size (1-1000 GB)" }, 400);
      if (!amount || amount <= 0 || amount > 10000)            return json({ success: false, message: "Invalid amount" }, 400);

      const orderId = `${orderPrefix}-` + Date.now().toString(36).toUpperCase() + "-MANUAL";

      // ── Recover store attribution from Paystack metadata ─────────────────
      // When guest-buy-data creates a recovery/pending order (due to amount
      // mismatch), the admin manually fulfils it here. We must reconstruct
      // the full external_response — especially storeownerid — so the order
      // appears in the store owner's dashboard and profit stats. Without this,
      // store-orders and store-stats filter on external_response->>storeownerid
      // and silently exclude every manually fulfilled order.
      let externalResponse: Record<string, unknown> = {
        payment_reference:  reference || null,
        manual_fallback:    true,
        manually_created:   true,
        created_by_admin:   user.id,
        // Fallback values — overwritten below if Paystack metadata is found
        base_cost:          amount,
        selling_price:      amount,
        profit:             0,
      };

      if (reference) {
        try {
          // Try paystack_verifications first, then webhook_orphans
          let meta: Record<string, any> = {};
          let paystackAmount = 0;

          const { data: pv } = await supabase
            .from("paystack_verifications")
            .select("paystack_response")
            .eq("reference", reference)
            .maybeSingle();

          if (pv?.paystack_response) {
            const pr = pv.paystack_response;
            meta           = pr.metadata || pr.data?.metadata || {};
            paystackAmount = ((pr.amount || pr.data?.amount || 0)) / 100; // pesewas → GHS
          } else {
            const { data: orph } = await supabase
              .from("webhook_orphans")
              .select("paystack_data, amount")
              .eq("reference", reference)
              .maybeSingle();

            if (orph) {
              meta           = orph.paystack_data?.metadata || {};
              paystackAmount = parseFloat(orph.amount || 0);
            }
          }

          // ── selling_price: read from custom_fields or reverse the 4% fee ──
          // store.html sends amount = base + 4% (totalAmount charged by Paystack)
          // and selling_price = base separately in custom_fields.bundle_price.
          // If that field is present, use it directly; otherwise back-calculate.
          let sellingPrice: number = amount; // safe fallback = what admin typed
          const bpField = (meta.custom_fields || []).find(
            (f: any) => f.variable_name === "bundle_price"
          );
          if (bpField?.value) {
            const parsed = parseFloat(String(bpField.value).replace(/[^\d.]/g, ""));
            if (!isNaN(parsed) && parsed > 0) sellingPrice = parsed;
          } else if (paystackAmount > 0) {
            // Reverse the 4% Paystack fee: totalAmount = base * 1.04 → base = total / 1.04
            sellingPrice = Math.round((paystackAmount / 1.04) * 100) / 100;
          }

          // ── base_cost: look up owner's wholesale price for this bundle ────
          const storeOwnerId:    string | null = meta.storeownerid    || meta.store_owner_id    || null;
          const storeOwnerEmail: string | null = meta.storeowneremail || meta.store_owner_email || null;
          let baseCost: number | null = null;

          if (storeOwnerId && size && network) {
            const { data: bundleRow } = await supabase
              .from("bundles")
              .select("id, price")
              .eq("network", network)
              .eq("size", size)
              .maybeSingle();

            if (bundleRow) {
              const { data: ubp } = await supabase
                .from("user_bundle_prices")
                .select("custom_price")
                .eq("user_id", storeOwnerId)
                .eq("bundle_id", bundleRow.id)
                .maybeSingle();

              baseCost = ubp
                ? parseFloat(ubp.custom_price)
                : parseFloat(bundleRow.price);
            }
          }

          const profit = (baseCost != null)
            ? Math.max(0, Math.round((sellingPrice - baseCost) * 100) / 100)
            : 0;

          externalResponse = {
            ...externalResponse,
            // Store attribution — required by store-orders and store-stats filters
            storeownerid:    storeOwnerId,
            storeowneremail: storeOwnerEmail,
            // Correct pricing — required for accurate profit calculation
            selling_price:   sellingPrice,
            base_cost:       baseCost ?? sellingPrice,
            profit,
            // Recovery metadata for traceability
            recipient:       meta.recipient   || meta.recipient_phone || phone,
            network:         meta.network     || network,
            bundle_size:     meta.bundle_size || size,
          };

          console.log(
            `create-manual: recovered store attribution — owner=${storeOwnerId}, ` +
            `selling=${sellingPrice}, cost=${baseCost}, profit=${profit}`
          );
        } catch (metaErr: any) {
          // Non-fatal: log and continue. The order is created with amount as
          // both selling_price and base_cost (profit = 0). Store stats will
          // be inaccurate for this order but no data is lost.
          console.warn("create-manual: could not recover Paystack metadata (non-fatal):", metaErr?.message ?? metaErr);
        }
      }

      const { error } = await supabase.from("adminorders").insert({
        userid:            null,
        order_reference:   orderId,
        payment_reference: reference || null,
        network,
        sparkdata_network: { mtn: "MTN", telecel: "TELECEL", airteltigo: "AIRTELTIGO_ISHARE" }[network] || network.toUpperCase(),
        recipient:         phone,
        package_size:      size,
        amount,
        status:            "pending",
        description:       `${network.toUpperCase()} ${size}GB Data Purchase (Manual — Orphaned Payment)`,
        external_response: externalResponse,
        created_at:        new Date().toISOString(),
      });
      if (error) throw error;

      await auditLog(supabase, user.id, "manual_order_create", {
        orderId, orderType, phone, network, size, amount,
        reference:    reference || null,
        storeownerid: externalResponse.storeownerid ?? null,
      });
      return json({ success: true, message: "Manual order created", orderId });
    }

    // ── GET STATS ──────────────────────────────────────────────────────────
    if (action === "get-stats") {
     const [totalRes, pendingRes, completedRes, failedRes] = await Promise.all([
  supabase.from("adminorders").select("id", { count: "exact", head: true }),

   supabase.from("adminorders")
  .select("id", { count: "exact", head: true })
  .in("status", ["processing", "processing_locked"]),

  supabase
    .from("adminorders")
    .select("id", { count: "exact", head: true })
    .eq("status", "completed"),

  supabase
    .from("adminorders")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed"),
]);
      return json({ success: true, stats: {
        total: totalRes.count || 0, pending: pendingRes.count || 0,
        completed: completedRes.count || 0, failed: failedRes.count || 0,
      }});
    }

    // ── RESOLVE WEBHOOK ORPHAN ─────────────────────────────────────────────
    if (action === "resolve-orphan") {
      const orphanId = body.orphanId as string;
      if (!orphanId) return json({ success: false, message: "Orphan ID required" }, 400);
      const { error } = await supabase
        .from("webhook_orphans")
        .update({ resolved: true, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", orphanId);
      if (error) throw error;
      await auditLog(supabase, user.id, "orphan_resolved", { orphanId });
      return json({ success: true, message: "Orphan marked as resolved" });
    }

    // ── GET SYSTEM SETTING ─────────────────────────────────────────────────
    if (action === "get-setting") {
      const key = body.key as string;
      if (!key) return json({ success: false, message: "Setting key required" }, 400);

      const ALLOWED_KEYS = [
        "active_provider",
        "deposit_method",
        "site_lock_dashboard",
        "site_lock_store",
      ];
      if (!ALLOWED_KEYS.includes(key)) {
        return json({ success: false, message: `Unknown setting key: ${key}` }, 400);
      }

      const { data, error } = await supabase
        .from("system_settings").select("value").eq("key", key).single();
      if (error && error.code !== "PGRST116") throw error;
      return json({ success: true, value: data?.value ?? null });
    }

    // ── SET SYSTEM SETTING ─────────────────────────────────────────────────
    if (action === "set-setting") {
      const key   = body.key   as string;
      const value = body.value as string;

      if (!key || value === undefined || value === null || value === "") {
        return json({ success: false, message: "Setting key and value required" }, 400);
      }

      // Enum-validated settings
      const ENUM_SETTINGS: Record<string, string[]> = {
        active_provider: ["justicedata", "pensite", "hubnet", "sparkdata", "databosshub"],
        deposit_method:  ["automatic", "manual"],
      };

      // JSON-validated settings (site lock)
      const JSON_SETTINGS = ["site_lock_dashboard", "site_lock_store"];

      if (ENUM_SETTINGS[key] !== undefined) {
        if (!ENUM_SETTINGS[key].includes(value)) {
          return json({ success: false, message: `Invalid value for ${key}. Allowed: ${ENUM_SETTINGS[key].join(", ")}` }, 400);
        }
      } else if (JSON_SETTINGS.includes(key)) {
        const check = validateSiteLockValue(String(value));
        if (!check.valid) {
          return json({ success: false, message: `Invalid value for ${key}: ${check.error}` }, 400);
        }
      } else {
        return json({ success: false, message: `Unknown setting key: ${key}` }, 400);
      }

      const { error } = await supabase.from("system_settings")
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
      if (error) throw error;

      await auditLog(supabase, user.id, "system_setting_update", { key, value });
      return json({ success: true, message: `Setting '${key}' updated` });
    }

    // ── GET MANUAL DEPOSITS ────────────────────────────────────────────────
    if (action === "get-manual-deposits") {
      const { data, error } = await supabase
        .from("manual_deposits")
        .select("*, users!user_id(fullname, email, phone)")
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return json({ success: true, deposits: data || [] });
    }

    // ── GET PAYSTACK HISTORY ───────────────────────────────────────────────
    if (action === "get-paystack-history") {
      const limit = Math.min(parseInt(String(body.limit || 50)), 200);
      const { data, error } = await supabase
        .from("paystack_verifications")
        .select("*, users(fullname, email, phone)")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return json({ success: true, deposits: data || [] });
    }

    // ── GET ORPHANED PAYMENTS ──────────────────────────────────────────────
    if (action === "get-orphaned-payments") {
      const [orphansRes, eventsRes, pvRes, ordersRes] = await Promise.all([
        supabase.from("webhook_orphans")
          .select("*").eq("resolved", false)
          .order("created_at", { ascending: false }).limit(100),
        supabase.from("webhook_events")
          .select("*").eq("processed", false)
          .order("created_at", { ascending: false }).limit(100),
        supabase.from("paystack_verifications")
          .select("reference, amount, created_at, status, user_id")
          .eq("status", "credited").like("reference", "GST-%")
          .order("created_at", { ascending: false }).limit(200),
        supabase.from("adminorders").select("order_reference, external_response"),
      ]);

      const orphans    = orphansRes.data  || [];
      const events     = eventsRes.error  ? null : (eventsRes.data || []);
      const pvPayments = pvRes.data       || [];
      const allOrders  = ordersRes.data   || [];

      const knownOrderRefs   = new Set(allOrders.map((o: any) => o.order_reference).filter(Boolean));
      const knownPaymentRefs = new Set(allOrders.map((o: any) => o.external_response?.payment_reference).filter(Boolean));
      const legacyOrphaned   = pvPayments.filter((p: any) =>
        !knownOrderRefs.has(p.reference) && !knownPaymentRefs.has(p.reference)
      );

      return json({ success: true, orphans, events, legacyOrphaned });
    }

    // ── GET ORDER PREFILL ──────────────────────────────────────────────────
    if (action === "get-order-prefill") {
      const ref = String(body.reference || "").trim();
      if (!ref) return json({ success: true, prefill: null });

      // 1. Existing adminorder by order_reference
      const { data: r1 } = await supabase
        .from("adminorders").select("recipient, network, package_size, amount, external_response")
        .eq("order_reference", ref).maybeSingle();
      if (r1?.recipient && r1.recipient !== "unknown") {
        return json({ success: true, prefill: {
          phone:        r1.recipient,
          network:      r1.network || "mtn",
          size:         r1.package_size || "",
          amount:       parseFloat(r1.amount || 0),
          selling_price: parseFloat(r1.external_response?.selling_price ?? r1.amount ?? 0),
          storeownerid: r1.external_response?.storeownerid ?? null,
        }});
      }

      // 2. Existing adminorder by payment_reference inside external_response
      const { data: r2 } = await supabase
        .from("adminorders").select("recipient, network, package_size, amount, external_response")
        .eq("external_response->>payment_reference", ref).maybeSingle();
      if (r2?.recipient && r2.recipient !== "unknown") {
        return json({ success: true, prefill: {
          phone:        r2.recipient,
          network:      r2.network || "mtn",
          size:         r2.package_size || "",
          amount:       parseFloat(r2.amount || 0),
          selling_price: parseFloat(r2.external_response?.selling_price ?? r2.amount ?? 0),
          storeownerid: r2.external_response?.storeownerid ?? null,
        }});
      }

      // 3. paystack_verifications — richest source; also extracts store attribution
      const { data: pv } = await supabase
        .from("paystack_verifications").select("paystack_response")
        .eq("reference", ref).maybeSingle();

      if (pv?.paystack_response) {
        const pr           = pv.paystack_response;
        const meta         = pr.metadata || pr.data?.metadata || {};
        const paystackAmt  = ((pr.amount || pr.data?.amount || 0)) / 100; // pesewas → GHS

        // selling_price from custom_fields or fee reversal
        let sellingPrice: number | null = null;
        const bpField = (meta.custom_fields || []).find((f: any) => f.variable_name === "bundle_price");
        if (bpField?.value) {
          const p = parseFloat(String(bpField.value).replace(/[^\d.]/g, ""));
          if (!isNaN(p) && p > 0) sellingPrice = p;
        } else if (paystackAmt > 0) {
          sellingPrice = Math.round((paystackAmt / 1.04) * 100) / 100;
        }

        if (meta.recipient || meta.phone_number) {
          return json({ success: true, prefill: {
            phone:        meta.recipient || meta.phone_number || "",
            network:      (meta.network  || "mtn").toLowerCase(),
            size:         meta.bundle_size || meta.package_size || "",
            amount:       paystackAmt,
            selling_price: sellingPrice,
            storeownerid: meta.storeownerid || meta.store_owner_id || null,
          }});
        }
      }

      // 4. webhook_orphans fallback
      const { data: orph } = await supabase
        .from("webhook_orphans").select("paystack_data, amount")
        .eq("reference", ref).maybeSingle();
      const oMeta      = orph?.paystack_data?.metadata || {};
      const orphAmount = parseFloat(orph?.amount || 0);

      let oSellingPrice: number | null = null;
      const oBpField = (oMeta.custom_fields || []).find((f: any) => f.variable_name === "bundle_price");
      if (oBpField?.value) {
        const p = parseFloat(String(oBpField.value).replace(/[^\d.]/g, ""));
        if (!isNaN(p) && p > 0) oSellingPrice = p;
      } else if (orphAmount > 0) {
        oSellingPrice = Math.round((orphAmount / 1.04) * 100) / 100;
      }

      if (oMeta.recipient || oMeta.phone_number) {
        return json({ success: true, prefill: {
          phone:        oMeta.recipient || oMeta.phone_number || "",
          network:      (oMeta.network  || "mtn").toLowerCase(),
          size:         oMeta.bundle_size || oMeta.package_size || "",
          amount:       orphAmount,
          selling_price: oSellingPrice,
          storeownerid: oMeta.storeownerid || oMeta.store_owner_id || null,
        }});
      }

      return json({ success: true, prefill: null });
    }

    // ── DASHBOARD STATS ────────────────────────────────────────────────────
    // Strategy: read from admin_dashboard_stats snapshot table first (fast).
    // The snapshot is populated by the refresh-stats edge function every hour.
    // If the snapshot is missing or older than 2 hours, fall back to live
    // queries and trigger a background refresh for next time.
    // manualPending is always fetched live — it must be real-time.
    if (action === "get-dashboard-stats") {
      const todayDate = new Date().toISOString().slice(0, 10);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // Always fetch manualPending live — admins need real-time visibility
      const manualPendingRes = await supabase
  .from("adminorders")
  .select("order_reference, recipient, amount, network, package_size, created_at, status")
  .in("status", ["manual_review", "failed_provider"])
  .order("created_at", { ascending: false });

      // ── Try snapshot table first ─────────────────────────────────────────
      const { data: snap } = await supabase
        .from("admin_dashboard_stats")
        .select("*")
        .eq("stat_date", todayDate)
        .maybeSingle();

      // Snapshot is fresh if computed within the last 2 hours
      const snapAge = snap?.computed_at
        ? (Date.now() - new Date(snap.computed_at).getTime()) / 1000 / 60
        : Infinity;
       const snapFresh = false;
      if (snapFresh) {
        console.log(`Serving dashboard stats from snapshot (age: ${Math.round(snapAge)}min)`);

        // Fetch all-time guest/store/user counts live — snapshot only tracks _today.
        // These are fast COUNT queries and must reflect all-time totals correctly.
        const [
          gstAllRes, storeAllRes, txnAllRes,
          pendingGstAllRes, pendingStoreAllRes, pendingTxnAllRes,
        ] = await Promise.all([
          supabase.from("adminorders").select("id", { count: "exact", head: true }).like("order_reference", "GST-%"),
          supabase.from("adminorders").select("id", { count: "exact", head: true }).not("external_response->>storeownerid", "is", null),
          supabase.from("adminorders").select("id", { count: "exact", head: true }).like("order_reference", "TXN-%"),
          supabase
  .from("adminorders")
  .select("id", { count: "exact", head: true })
  .like("order_reference", "GST-%")
  .in("status", ["manual_review", "failed_provider"]),

supabase
  .from("adminorders")
  .select("id", { count: "exact", head: true })
  .not("external_response->>storeownerid", "is", null)
  .in("status", ["manual_review", "failed_provider"]),

supabase
  .from("adminorders")
  .select("id", { count: "exact", head: true })
  .like("order_reference", "TXN-%")
  .in("status", ["manual_review", "failed_provider"]),
        ]);

        return json({
          success: true,
          source: "snapshot+live",
          computed_at: snap.computed_at,
          revenue: {
            total: parseFloat(snap.revenue_all_time  || 0),
            today: parseFloat(snap.revenue_today     || 0),
          },
          orders: {
            total:        snap.total_orders_all_time  || 0,
             today:        snap.total_orders_today     || 0,
            completed:    snap.successful_orders_today || 0,
            pending:      snap.pending_orders          || 0,
            guest:        gstAllRes.count             || 0,
            store:        storeAllRes.count            || 0,
            user:         txnAllRes.count              || 0,
            pendingGuest: pendingGstAllRes.count       || 0,
            pendingStore: pendingStoreAllRes.count      || 0,
            pendingUser:  pendingTxnAllRes.count        || 0,
          },
       users: {
  total: snap.total_users || 0,
  activeToday: snap.active_users_today || 0
  },  manualPending: manualPendingRes.data || [],
        });
      }

      // ── Snapshot missing or stale — run live queries ──────────────────────
      console.log(snap
        ? `Snapshot stale (${Math.round(snapAge)}min) — running live queries`
        : "No snapshot for today — running live queries"
      );

 const [
  totalUsersRes,
  todayOrdersRes,
  allOrdersRes,
  completedOrdersRes,
  pendingOrdersRes,
  gstOrdersRes,
  storeOrdersRes,
  txnOrdersRes,
  pendingGstRes,
  pendingStoreRes,
  pendingTxnRes,
] = await Promise.all([
    supabase.from("users").select("id", { count: "exact", head: true }),
    supabase
  .from("adminorders")
  .select("id", { count: "exact", head: true })
  .gte("created_at", todayStart.toISOString())
  .neq("status", "payment_pending"),
        supabase.from("adminorders").select("id", { count: "exact", head: true }),
        supabase.from("adminorders").select("id", { count: "exact", head: true }).eq("status", "completed"),
       supabase.from("adminorders").select("id", { count: "exact", head: true }).in("status", ["processing", "processing_locked"]),
        // Guest: GST- prefix (GST-MM, GST-MN, GST-MO, GST-MP, GST-17, etc.)
        supabase.from("adminorders").select("id", { count: "exact", head: true }).like("order_reference", "GST-%"),
        // Store: identified by storeownerid in external_response (most reliable)
        supabase.from("adminorders").select("id", { count: "exact", head: true }).not("external_response->>storeownerid", "is", null),
        // User: TXN- prefix (TXN-MO, TXN-MN, TXN-MM, TXN-MP, etc.)
        supabase.from("adminorders").select("id", { count: "exact", head: true }).like("order_reference", "TXN-%"),
      supabase
  .from("adminorders")
  .select("id", { count: "exact", head: true })
  .like("order_reference", "GST-%")
  .in("status", ["processing", "processing_locked"]),

supabase
  .from("adminorders")
  .select("id", { count: "exact", head: true })
  .not("external_response->>storeownerid", "is", null)
  .in("status", ["processing", "processing_locked"]),
supabase
  .from("adminorders")
  .select("id", { count: "exact", head: true })
  .like("order_reference", "TXN-%")
  .in("status", ["processing", "processing_locked"]),
       supabase
  .from("adminorders")
  .select("id", { count: "exact", head: true })
  .gte("created_at", todayStart.toISOString())
  .neq("status", "payment_pending"),
      ]);

      const { data: completedAmounts } = await supabase
        .from("adminorders").select("amount, created_at").eq("status", "completed");

      const totalRevenue = (completedAmounts || []).reduce((sum, o) => sum + Math.abs(parseFloat(o.amount) || 0), 0);
      const todayRevenue = (completedAmounts || [])
        .filter(o => new Date(o.created_at) >= todayStart)
        .reduce((sum, o) => sum + Math.abs(parseFloat(o.amount) || 0), 0);

      // Trigger background snapshot refresh so next call gets the fast path.
      // Fire-and-forget — don't await, don't block the response.
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SERVICE_KEY) {
        fetch(`${SUPABASE_URL}/functions/v1/refresh-stats`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
        }).catch(e => console.warn("Background refresh-stats trigger failed (non-fatal):", e.message));
      }

      return json({
        success: true,
        source: "live",
        revenue: { total: totalRevenue, today: todayRevenue },
        orders: {
          total:        allOrdersRes.count       || 0,
          today:        todayOrdersRes.count      || 0,
          completed:    completedOrdersRes.count  || 0,
          pending:      pendingOrdersRes.count    || 0,
          guest:        gstOrdersRes.count        || 0,
          store:        storeOrdersRes.count      || 0,
          user:         txnOrdersRes.count        || 0,
          pendingGuest: pendingGstRes.count       || 0,
          pendingStore: pendingStoreRes.count     || 0,
          pendingUser:  pendingTxnRes.count       || 0,
        },
 users: {
  total: totalUsersRes.count || 0,
  activeToday: todayOrdersRes.count || 0
},
        manualPending: manualPendingRes.data || [],
      });
    }

    // ── GET ORDER ──────────────────────────────────────────────────────────
    if (action === "get-order") {
      const orderId = body.orderId as string;
      if (!orderId || typeof orderId !== "string") {
        return json({ success: false, message: "Order ID required" }, 400);
      }
      const { data: order, error } = await supabase
        .from("adminorders")
        .select("*, users(fullname, email, phone)")
        .eq("id", orderId)
        .single();
      if (error) {
        // PGRST116 = no rows returned by .single() — not a server error
        if (error.code === "PGRST116") {
          return json({ success: false, message: "Order not found" }, 404);
        }
        throw error;
      }
      if (!order) return json({ success: false, message: "Order not found" }, 404);
      return json({ success: true, order });
    }

    // ── APPROVE MANUAL DEPOSIT ─────────────────────────────────────────────
    if (action === "approve-manual-deposit") {
      const depositId = body.depositId as string;
      if (!depositId) return json({ success: false, message: "Deposit ID required" }, 400);

      const { data, error } = await supabase.rpc("admin_approve_manual_deposit", {
        p_deposit_id: depositId,
        p_admin_id:   user.id,
        p_admin_note: "Approved by admin",
      });
      if (error) throw error;
      if (!data?.success) return json({ success: false, message: data?.message || "Approval failed" }, 400);

      await auditLog(supabase, user.id, "manual_deposit_approved", {
        depositId,
        amount: data.amount,
      });
      console.log(`Manual deposit ${depositId} approved by admin ${user.id}`);
      return json({ success: true, message: `Approved! ${data.amount} credited to user wallet`, amount: data.amount });
    }

    // ── DECLINE MANUAL DEPOSIT ─────────────────────────────────────────────
    if (action === "decline-manual-deposit") {
      const depositId = body.depositId as string;
      const reason    = (body.reason as string) || "Declined by admin";
      if (!depositId) return json({ success: false, message: "Deposit ID required" }, 400);

      const { data, error } = await supabase.rpc("admin_decline_manual_deposit", {
        p_deposit_id: depositId,
        p_admin_id:   user.id,
        p_admin_note: reason,
      });
      if (error) throw error;
      if (!data?.success) return json({ success: false, message: data?.message || "Decline failed" }, 400);

      await auditLog(supabase, user.id, "manual_deposit_declined", { depositId, reason });
      console.log(`Manual deposit ${depositId} declined by admin ${user.id}`);
      return json({ success: true, message: "Deposit declined" });
    }

    // ── GET ANALYTICS ──────────────────────────────────────────────────────
    // Called by admin Sales Analytics page.
    // Accepts: { action, network?, days? }
    //   network — 'all' | 'mtn' | 'telecel' | 'airteltigo'  (default: 'all')
    //   days    — integer 7 | 30 | 90 | 365                  (default: 365)
    // Returns:
    //   periodRevenue, periodOrders, ordersToday, revenueToday,
    //   ordersThisWeek, avgOrderValue,
    //   daily   — [{ date: 'YYYY-MM-DD', revenue, orders }]
    //   byNetwork — [{ network, revenue, orders, share }]
    // All queries run server-side through service_role — zero direct DB access from browser.
    if (action === "get-analytics") {
      const networkFilter = (body.network as string || "all").toLowerCase();
      const days          = Math.min(365, Math.max(1, parseInt(String(body.days || 365))));

      const VALID_NETWORKS = ["mtn", "telecel", "airteltigo"];
      if (networkFilter !== "all" && !VALID_NETWORKS.includes(networkFilter)) {
        return json({ success: false, message: "Invalid network filter" }, 400);
      }

      // ── Date boundaries ───────────────────────────────────────────────────
      const now      = new Date();
      const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const periodStart = new Date(todayUTC);
      periodStart.setUTCDate(periodStart.getUTCDate() - days + 1);

      const weekStart = new Date(todayUTC);
      weekStart.setUTCDate(weekStart.getUTCDate() - 6);

      // ── Fetch completed orders in period ──────────────────────────────────
      // Only completed orders count as revenue. No pending/failed included.
      let query = supabase
        .from("adminorders")
        .select("amount, network, created_at")
        .eq("status", "completed")
        .gte("created_at", periodStart.toISOString());

      if (networkFilter !== "all") {
        query = query.eq("network", networkFilter);
      }

      // ── Fetch ALL orders placed today (any status) for the stat card ───────
      // We fetch rows (not a HEAD count) so we can both count and sum revenue
      // in JS — consistent with how other parts of this file handle today's
      // data, and avoids any timezone/head-request edge cases.
      const tomorrowUTC = new Date(todayUTC);
      tomorrowUTC.setUTCDate(tomorrowUTC.getUTCDate() + 1);

      // Use date string cast on the DB side to avoid any UTC offset ambiguity.
      // Supabase/Postgres: created_at::date = '2026-05-08' matches regardless
      // of whether the timestamp is stored as UTC or with timezone offset.
      const todayStr2 = todayUTC.toISOString().slice(0, 10); // e.g. "2026-05-08"
      let todayOrdersQuery = supabase
        .from("adminorders")
        .select("id, amount, status, created_at")
        .gte("created_at", todayUTC.toISOString())
        .lt("created_at",  tomorrowUTC.toISOString());

      if (networkFilter !== "all") {
        todayOrdersQuery = todayOrdersQuery.eq("network", networkFilter);
      }

      const [
        { data: orders, error },
        { data: todayOrdersRows, error: todayErr },
      ] = await Promise.all([query, todayOrdersQuery]);
      if (error) throw error;
      if (todayErr) throw todayErr;

      // ── DEBUG: log what the DB actually returned for today ────────────────
      // Check your Supabase edge function logs to see these values.
      console.log("[orders-today-debug]", JSON.stringify({
        serverNow:       now.toISOString(),
        todayUTC:        todayUTC.toISOString(),
        tomorrowUTC:     tomorrowUTC.toISOString(),
        todayStr2,
        dbRowCount:      (todayOrdersRows || []).length,
        dbRows:          (todayOrdersRows || []).map(r => ({
          id:         r.id,
          status:     r.status,
          amount:     r.amount,
          created_at: r.created_at,
        })),
      }));

      const todayRows = (todayOrdersRows || []).filter(r => {
        if (!r.created_at) return true;
        const ts = new Date(r.created_at).getTime();
        const withinUTC = ts >= todayUTC.getTime() && ts < tomorrowUTC.getTime();
        const dateMatch = r.created_at.slice(0, 10) === todayStr2;
        return withinUTC || dateMatch;
      });
      const totalOrdersToday       = todayRows.length;
      const revenueTodayAllStatuses = todayRows
        .filter(r => r.status !== "failed")
        .reduce((sum, r) => sum + Math.abs(parseFloat(r.amount) || 0), 0);

      const rows = orders || [];

      // ── Stat card calculations ─────────────────────────────────────────────
      const todayStr = todayUTC.toISOString().slice(0, 10);
      const weekStartStr = weekStart.toISOString().slice(0, 10);

      let periodRevenue  = 0;
      let revenueToday   = 0;
      let ordersToday    = 0;
      let ordersThisWeek = 0;

      for (const o of rows) {
        const amt     = Math.abs(parseFloat(o.amount) || 0);
        const dateStr = (o.created_at || "").slice(0, 10);
        periodRevenue += amt;
        if (dateStr === todayStr)       { revenueToday += amt; } // ordersToday now counted via totalOrdersToday (all statuses)
        if (dateStr >= weekStartStr)    { ordersThisWeek++; }
      }

      const periodOrders = rows.length;
      const avgOrderValue = periodOrders > 0 ? periodRevenue / periodOrders : 0;

      // ── Daily revenue grouped by date ──────────────────────────────────────
      // Build a map date→{revenue,orders} then fill every date in the period
      const dailyMap: Record<string, { revenue: number; orders: number }> = {};
      for (const o of rows) {
        const d   = (o.created_at || "").slice(0, 10);
        const amt = Math.abs(parseFloat(o.amount) || 0);
        if (!dailyMap[d]) dailyMap[d] = { revenue: 0, orders: 0 };
        dailyMap[d].revenue += amt;
        dailyMap[d].orders++;
      }

      // Fill every calendar day in the period so the chart has no gaps
      const daily: { date: string; revenue: number; orders: number }[] = [];
      const cursor = new Date(periodStart);
      while (cursor <= todayUTC) {
        const d = cursor.toISOString().slice(0, 10);
        daily.push({ date: d, revenue: dailyMap[d]?.revenue || 0, orders: dailyMap[d]?.orders || 0 });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      // ── Revenue by network ─────────────────────────────────────────────────
      const networkMap: Record<string, { revenue: number; orders: number }> = {};
      for (const o of rows) {
        const net = (o.network || "unknown").toLowerCase();
        if (!networkMap[net]) networkMap[net] = { revenue: 0, orders: 0 };
        networkMap[net].revenue += Math.abs(parseFloat(o.amount) || 0);
        networkMap[net].orders++;
      }

      const byNetwork = Object.entries(networkMap)
        .map(([network, stats]) => ({
          network,
          revenue: parseFloat(stats.revenue.toFixed(2)),
          orders:  stats.orders,
          share:   periodRevenue > 0
            ? parseFloat(((stats.revenue / periodRevenue) * 100).toFixed(1))
            : 0,
        }))
        .sort((a, b) => b.revenue - a.revenue);

      return json({
        success:       true,
        periodRevenue: parseFloat(periodRevenue.toFixed(2)),
        periodOrders,
        revenueToday:  parseFloat(revenueTodayAllStatuses.toFixed(2)), // all non-failed orders today
        ordersToday: totalOrdersToday ?? 0,  // all statuses placed today
        ordersThisWeek,
        avgOrderValue: parseFloat(avgOrderValue.toFixed(2)),
        daily,
        byNetwork,
      });
    }

    // ── EXPORT CSV ─────────────────────────────────────────────────────────
    // Called by admin Analytics page export button.
    // Accepts: { action, network?, days?, type? }
    //   network — 'all' | 'mtn' | 'telecel' | 'airteltigo'  (default: 'all')
    //   days    — integer 7 | 30 | 90 | 365                  (default: 365)
    //   type    — 'orders' | 'revenue'                        (default: 'orders')
    // Returns: { success, csv, filename, rowCount }
    // All data fetched server-side via service_role — zero direct DB access from browser.
    if (action === "export-csv") {
      const networkFilter = (body.network as string || "all").toLowerCase();
      const days          = Math.min(365, Math.max(1, parseInt(String(body.days || 365))));
      const exportType    = (body.type as string || "orders").toLowerCase();

      const VALID_NETWORKS = ["mtn", "telecel", "airteltigo"];
      if (networkFilter !== "all" && !VALID_NETWORKS.includes(networkFilter)) {
        return json({ success: false, message: "Invalid network filter" }, 400);
      }
      if (!["orders", "revenue"].includes(exportType)) {
        return json({ success: false, message: "Invalid export type. Must be 'orders' or 'revenue'" }, 400);
      }

      const now         = new Date();
      const todayUTC    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const periodStart = new Date(todayUTC);
      periodStart.setUTCDate(periodStart.getUTCDate() - days + 1);

      let query = supabase
        .from("adminorders")
        .select("id, order_reference, network, package_size, recipient, amount, status, description, created_at, external_response")
        .eq("status", "completed")
        .gte("created_at", periodStart.toISOString())
        .order("created_at", { ascending: false });

      if (networkFilter !== "all") {
        query = query.eq("network", networkFilter);
      }

      const { data: rows, error } = await query;
      if (error) throw error;

      const orders = rows || [];

      let csvContent = "";
      const dateLabel = days >= 365 ? "All time" : `Last ${days} days`;
      const networkLabel = networkFilter === "all" ? "All networks" : networkFilter.toUpperCase();
      const exportedAt = now.toISOString().replace("T", " ").slice(0, 19) + " UTC";

      if (exportType === "orders") {
        // Full order list export
        const headers = [
          "Order Reference",
          "Network",
          "Bundle (GB)",
          "Recipient Phone",
          "Amount (GH₵)",
          "Status",
          "Description",
          "Date",
        ];
        const escapeCell = (val: unknown): string => {
          const str = String(val ?? "");
          // RFC 4180: wrap in quotes if contains comma, quote, or newline
          if (str.includes(",") || str.includes('"') || str.includes("\n")) {
            return '"' + str.replace(/"/g, '""') + '"';
          }
          return str;
        };

        csvContent = [
          `# Prime Connect — Order Export`,
          `# Period: ${dateLabel} | Network: ${networkLabel} | Exported: ${exportedAt}`,
          `# Total orders: ${orders.length}`,
          ``,
          headers.join(","),
          ...orders.map(o => [
            escapeCell(o.order_reference),
            escapeCell((o.network || "").toUpperCase()),
            escapeCell(o.package_size),
            escapeCell(o.recipient),
            escapeCell(Math.abs(parseFloat(o.amount) || 0).toFixed(2)),
            escapeCell(o.status),
            escapeCell(o.description),
            escapeCell((o.created_at || "").slice(0, 19).replace("T", " ")),
          ].join(",")),
        ].join("\r\n");

      } else {
        // Daily revenue summary export
        const dailyMap: Record<string, { revenue: number; orders: number }> = {};
        for (const o of orders) {
          const d   = (o.created_at || "").slice(0, 10);
          const amt = Math.abs(parseFloat(o.amount) || 0);
          if (!dailyMap[d]) dailyMap[d] = { revenue: 0, orders: 0 };
          dailyMap[d].revenue += amt;
          dailyMap[d].orders++;
        }

        // Network breakdown
        const networkMap: Record<string, { revenue: number; orders: number }> = {};
        for (const o of orders) {
          const net = (o.network || "unknown").toLowerCase();
          if (!networkMap[net]) networkMap[net] = { revenue: 0, orders: 0 };
          networkMap[net].revenue += Math.abs(parseFloat(o.amount) || 0);
          networkMap[net].orders++;
        }

        const totalRevenue = orders.reduce((s, o) => s + Math.abs(parseFloat(o.amount) || 0), 0);
        const avgOrder     = orders.length > 0 ? totalRevenue / orders.length : 0;

        csvContent = [
          `# Prime Connect — Revenue Summary Export`,
          `# Period: ${dateLabel} | Network: ${networkLabel} | Exported: ${exportedAt}`,
          ``,
          `## Summary`,
          `Total Revenue (GH₵),Total Orders,Avg Order Value (GH₵)`,
          `${totalRevenue.toFixed(2)},${orders.length},${avgOrder.toFixed(2)}`,
          ``,
          `## Network Breakdown`,
          `Network,Revenue (GH₵),Orders,Share (%)`,
          ...Object.entries(networkMap)
            .sort((a, b) => b[1].revenue - a[1].revenue)
            .map(([net, stats]) => [
              net.toUpperCase(),
              stats.revenue.toFixed(2),
              stats.orders,
              totalRevenue > 0 ? ((stats.revenue / totalRevenue) * 100).toFixed(1) : "0.0",
            ].join(",")),
          ``,
          `## Daily Revenue`,
          `Date,Revenue (GH₵),Orders`,
          ...Object.entries(dailyMap)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([date, stats]) => `${date},${stats.revenue.toFixed(2)},${stats.orders}`),
        ].join("\r\n");
      }

      const safePeriod  = dateLabel.toLowerCase().replace(/\s+/g, "-");
      const safeNetwork = networkFilter === "all" ? "all-networks" : networkFilter;
      const dateStamp   = now.toISOString().slice(0, 10);
      const filename    = `primeconnect-${exportType}-${safeNetwork}-${safePeriod}-${dateStamp}.csv`;

      await auditLog(supabase, user.id, "export_csv", {
        exportType, networkFilter, days, rowCount: orders.length,
      });

      return json({ success: true, csv: csvContent, filename, rowCount: orders.length });
    }

    // ── EXPORT PDF DATA ────────────────────────────────────────────────────
    // Returns structured JSON the frontend uses to render a PDF client-side
    // via jsPDF. Keeping PDF rendering client-side avoids Deno binary deps.
    // Accepts: { action, network?, days? }
    // Returns: { success, reportData, filename }
    if (action === "export-pdf") {
      const networkFilter = (body.network as string || "all").toLowerCase();
      const days          = Math.min(365, Math.max(1, parseInt(String(body.days || 365))));

      const VALID_NETWORKS = ["mtn", "telecel", "airteltigo"];
      if (networkFilter !== "all" && !VALID_NETWORKS.includes(networkFilter)) {
        return json({ success: false, message: "Invalid network filter" }, 400);
      }

      const now         = new Date();
      const todayUTC    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const periodStart = new Date(todayUTC);
      periodStart.setUTCDate(periodStart.getUTCDate() - days + 1);

      const weekStart = new Date(todayUTC);
      weekStart.setUTCDate(weekStart.getUTCDate() - 6);

      let query = supabase
        .from("adminorders")
        .select("amount, network, created_at, status, order_reference, package_size, recipient, description")
        .eq("status", "completed")
        .gte("created_at", periodStart.toISOString())
        .order("created_at", { ascending: false });

      if (networkFilter !== "all") {
        query = query.eq("network", networkFilter);
      }

      // Also fetch top 10 orders by amount for the PDF summary table
      let topQuery = supabase
        .from("adminorders")
        .select("order_reference, network, package_size, recipient, amount, created_at, description")
        .eq("status", "completed")
        .gte("created_at", periodStart.toISOString())
        .order("amount", { ascending: false })
        .limit(10);

      if (networkFilter !== "all") {
        topQuery = topQuery.eq("network", networkFilter);
      }

      const [{ data: rows, error }, { data: topRows, error: topErr }] = await Promise.all([query, topQuery]);
      if (error) throw error;
      if (topErr) throw topErr;

      const orders = rows || [];

      // ── Stat calculations ─────────────────────────────────────────────────
      const totalRevenue  = orders.reduce((s, o) => s + Math.abs(parseFloat(o.amount) || 0), 0);
      const totalOrders   = orders.length;
      const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

      const todayStr    = todayUTC.toISOString().slice(0, 10);
      const weekStartStr = weekStart.toISOString().slice(0, 10);

      let revenueToday   = 0;
      let ordersToday    = 0;
      let ordersThisWeek = 0;
      for (const o of orders) {
        const d   = (o.created_at || "").slice(0, 10);
        const amt = Math.abs(parseFloat(o.amount) || 0);
        if (d === todayStr)    { revenueToday += amt; ordersToday++; }
        if (d >= weekStartStr) { ordersThisWeek++; }
      }

      // ── Daily breakdown ───────────────────────────────────────────────────
      const dailyMap: Record<string, { revenue: number; orders: number }> = {};
      for (const o of orders) {
        const d   = (o.created_at || "").slice(0, 10);
        const amt = Math.abs(parseFloat(o.amount) || 0);
        if (!dailyMap[d]) dailyMap[d] = { revenue: 0, orders: 0 };
        dailyMap[d].revenue += amt;
        dailyMap[d].orders++;
      }
      const daily = Object.entries(dailyMap)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, s]) => ({ date, revenue: parseFloat(s.revenue.toFixed(2)), orders: s.orders }));

      // ── Network breakdown ─────────────────────────────────────────────────
      const networkMap: Record<string, { revenue: number; orders: number }> = {};
      for (const o of orders) {
        const net = (o.network || "unknown").toLowerCase();
        if (!networkMap[net]) networkMap[net] = { revenue: 0, orders: 0 };
        networkMap[net].revenue += Math.abs(parseFloat(o.amount) || 0);
        networkMap[net].orders++;
      }
      const byNetwork = Object.entries(networkMap)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .map(([network, s]) => ({
          network: network.toUpperCase(),
          revenue: parseFloat(s.revenue.toFixed(2)),
          orders:  s.orders,
          share:   totalRevenue > 0
            ? parseFloat(((s.revenue / totalRevenue) * 100).toFixed(1))
            : 0,
        }));

      const dateLabel    = days >= 365 ? "All time" : `Last ${days} days`;
      const networkLabel = networkFilter === "all" ? "All Networks" : networkFilter.toUpperCase();
      const safePeriod   = dateLabel.toLowerCase().replace(/\s+/g, "-");
      const safeNetwork  = networkFilter === "all" ? "all-networks" : networkFilter;
      const dateStamp    = now.toISOString().slice(0, 10);
      const filename     = `primeconnect-report-${safeNetwork}-${safePeriod}-${dateStamp}.pdf`;

      await auditLog(supabase, user.id, "export_pdf", {
        networkFilter, days, rowCount: orders.length,
      });

      return json({
        success: true,
        filename,
        reportData: {
          meta: {
            title:       "Prime Connect — Analytics Report",
            period:      dateLabel,
            network:     networkLabel,
            generatedAt: now.toISOString().replace("T", " ").slice(0, 19) + " UTC",
            generatedBy: user.id,
          },
          summary: {
            totalRevenue:  parseFloat(totalRevenue.toFixed(2)),
            totalOrders,
            avgOrderValue: parseFloat(avgOrderValue.toFixed(2)),
            revenueToday:  parseFloat(revenueToday.toFixed(2)),
            ordersToday,
            ordersThisWeek,
          },
          byNetwork,
          daily,
          topOrders: (topRows || []).map(o => ({
            reference:   o.order_reference,
            network:     (o.network || "").toUpperCase(),
            bundleGb:    o.package_size,
            recipient:   o.recipient,
            amount:      Math.abs(parseFloat(o.amount) || 0).toFixed(2),
            description: o.description,
            date:        (o.created_at || "").slice(0, 10),
          })),
        },
      });
    }

    return json({ success: false, message: `Unknown action: ${action}` }, 400);

  } catch (err) {
    console.error("admin-manage-orders error:", err);
    return json({ success: false, message: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});