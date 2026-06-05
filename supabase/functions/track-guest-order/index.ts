/**
 * track-guest-order — Supabase Edge Function
 *
 * Allows guests to track their orders by phone number or reference.
 * Queries guest_orders table (primary) and falls back to adminorders.
 *
 * Request body (one of):
 *   { phone: "0241234567" }          — returns GUEST-only orders for that recipient
 *   { reference: "GST-xxx-xxx" }     — returns the specific order
 *
 * Store orders are excluded when tracking by phone — store customers
 * use the store's own tracking page (store.html).
 * When tracking by reference, any matching order is returned since
 * the customer has the exact reference and wants that specific order.
 *
 * Deploy:
 *   supabase functions deploy track-guest-order --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function ok(orders: any[]): Response {
  return new Response(
    JSON.stringify({ success: true, orders }),
    { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
  );
}

function fail(message: string, status = 400): Response {
  return new Response(
    JSON.stringify({ success: false, message }),
    { status, headers: { ...CORS, "Content-Type": "application/json" } },
  );
}

// Normalise phone to 0XXXXXXXXX (10 digits)
function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("233") && digits.length === 12) return "0" + digits.slice(3);
  if (digits.startsWith("0")   && digits.length === 10) return digits;
  return null;
}

// Safe fields returned to the guest — no internal costs, no user IDs
function sanitiseOrder(row: any) {
  return {
    order_reference: row.order_reference,
    reference:       row.order_reference,
    network:         row.network,
    package_size:    row.package_size,
    amount:          row.amount,
    status:          row.status,
    created_at:      row.created_at,
    updated_at:      row.updated_at,
  };
}

// Returns true if this row belongs to a store owner.
// For guest_orders rows: check store_id column.
// For adminorders rows: check storeownerid inside external_response.
function isStoreOrder(row: any): boolean {
  // guest_orders uses store_id column
  if (row?.store_id !== undefined) {
    return row.store_id !== null && row.store_id !== "" && row.store_id !== "null";
  }
  // adminorders uses external_response.storeownerid
  const v = row?.external_response?.storeownerid;
  return v !== null && v !== undefined && v !== "" && v !== "null";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return fail("Method not allowed", 405);

  const SUPABASE_URL              = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return fail("Server configuration error", 500);
  }

  let body: { phone?: string; reference?: string };
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body");
  }

  const { phone, reference } = body;

  if (!phone && !reference) {
    return fail("Provide either a phone number or an order reference");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {

    // ── Track by reference ────────────────────────────────────────────────────
    // Return any matching order regardless of guest/store — the customer has
    // the exact reference so they clearly own it.
    if (reference) {
      const ref = reference.trim().toUpperCase();

      const knownPrefixes = ["GST-", "STORE-", "PAY-", "TXN-"];
      if (!knownPrefixes.some(p => ref.startsWith(p))) {
        return fail("Invalid reference format. Expected a reference like GST-xxxxx");
      }

      // Check guest_orders first (primary tracking table)
      const { data: guestRow } = await supabase
        .from("guest_orders")
        .select("order_reference, network, package_size, amount, status, created_at, updated_at")
        .eq("order_reference", ref)
        .maybeSingle();

      if (guestRow) return ok([sanitiseOrder(guestRow)]);

      // Also check by payment_reference in guest_orders
      const { data: guestByPayRef } = await supabase
        .from("guest_orders")
        .select("order_reference, network, package_size, amount, status, created_at, updated_at")
        .eq("payment_reference", ref)
        .maybeSingle();

      if (guestByPayRef) return ok([sanitiseOrder(guestByPayRef)]);

      // Fall back to adminorders — exclude ghost recovery records only
      const { data: adminRow } = await supabase
        .from("adminorders")
        .select("order_reference, network, package_size, amount, status, created_at, updated_at, external_response")
        .eq("order_reference", ref)
        .neq("external_response->>webhook_recovery", "true")
        .maybeSingle();

      if (adminRow) return ok([sanitiseOrder(adminRow)]);

      // Also check adminorders by payment_reference inside external_response
      const { data: adminByPayRef } = await supabase
        .from("adminorders")
        .select("order_reference, network, package_size, amount, status, created_at, updated_at, external_response")
        .eq("external_response->>payment_reference", ref)
        .neq("external_response->>webhook_recovery", "true")
        .maybeSingle();

      if (adminByPayRef) return ok([sanitiseOrder(adminByPayRef)]);

      return ok([]);
    }

    // ── Track by phone — GUEST ORDERS ONLY ───────────────────────────────────
    // Store orders are excluded here. If someone bought from a store AND as a
    // guest, only their direct guest purchases appear. Store purchases are
    // tracked on the store's own tracking page.
    if (phone) {
      const normPhone = normalisePhone(phone);
      if (!normPhone) {
        return fail("Invalid phone number — enter a 10-digit Ghanaian number starting with 0");
      }

      // guest_orders: only rows with no store_id (pure guest orders)
      const { data: guestRows } = await supabase
        .from("guest_orders")
        .select("order_reference, network, package_size, amount, status, created_at, updated_at, store_id")
        .eq("recipient", normPhone)
        .is("store_id", null)                              // guest orders only
        .order("created_at", { ascending: false })
        .limit(10);

      if (guestRows && guestRows.length > 0) {
        return ok(guestRows.map(sanitiseOrder));
      }

      // Fallback: adminorders — fetch more than needed, then filter store orders
      // in JS because PostgREST cannot do IS NULL checks on nested JSON keys.
      const { data: adminRows } = await supabase
        .from("adminorders")
        .select("order_reference, network, package_size, amount, status, created_at, updated_at, external_response")
        .eq("recipient", normPhone)
        .neq("external_response->>webhook_recovery", "true")  // exclude ghosts
        .order("created_at", { ascending: false })
        .limit(20);

      // Filter out store orders in JavaScript
      const guestOnlyRows = (adminRows || []).filter(row => !isStoreOrder(row));

      if (guestOnlyRows.length > 0) {
        return ok(guestOnlyRows.slice(0, 10).map(sanitiseOrder));
      }

      return ok([]);
    }

  } catch (err) {
    console.error("track-guest-order error:", err);
    return fail(err instanceof Error ? err.message : "Internal server error", 500);
  }

  return fail("Invalid request");
});