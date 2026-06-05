/**
 * guest-buy-data — Supabase Edge Function
 *
 * Called by: store.html -> processStorePurchase() after Paystack payment succeeds.
 *
 * ── FIX 2026-05-A ───────────────────────────────────────────────────────────────
 * [FIX-1] PRE-REGISTRATION SUPPORT
 *   store.html now calls this function BEFORE opening Paystack (status=payment_pending).
 *   This eliminates the race condition where the Paystack webhook fires before the
 *   order exists in the DB, causing "No real order found" → recovery record creation.
 *
 *   Pre-registration flow:
 *     body.status === 'payment_pending'
 *       → upsert into guest_orders + adminorders with status='payment_pending'
 *       → return early (no provider call)
 *
 *   Normal fulfillment flow (after Paystack callback):
 *     body.status !== 'payment_pending'
 *       → idempotency check → upgrade payment_pending record → place provider order
 *
 * [FIX-2] PROVIDER AUTO-FALLBACK
 *   If the active provider (e.g. databosshub) fails with a 5xx/network error,
 *   automatically retry with the configured fallback provider (default: justicedata).
 *   Fallback provider is read from system_settings key 'fallback_provider'.
 *   Set fallback_provider = 'none' to disable.
 *
 * ── FIX 2026-05-B (pricing bug) ─────────────────────────────────────────────────
 * [FIX-3] REMOVE FEE-REVERSAL FALLBACK FROM sellingPriceHint
 *   Previously: if selling_price was missing, sellingPriceHint = amount / 1.04
 *   Bug: when the Paystack webhook re-processed an already-fulfilled order, it passed
 *   amount=9.30 (the base price, not the gross), so 9.30 / 1.04 = 8.94 was used as
 *   the selling price — stripping the fee twice and corrupting the admin portal price.
 *   Fix: if selling_price is absent, pass 0 and let resolvePricing() use the DB price.
 *
 * [FIX-4] HARDEN IDEMPOTENCY CHECK
 *   Previously: allowed fulfillment through if status === 'payment_pending', blocked all others.
 *   Bug: 'pending' (manual queue) was not in the blocked list, so a webhook retry on a
 *   manually-queued order could re-process it and overwrite the amount.
 *   Fix: explicitly block on all post-payment statuses:
 *   processing | completed | delivered | pending | failed | cancelled
 *   Only payment_pending falls through to fulfillment.
 *
 * Provider switching:
 *   Reads 'active_provider' from system_settings ->
 *   justicedata | pensite | hubnet | sparkdata | databosshub
 *   Falls back to 'justicedata' if not set.
 *   If ALL providers fail, order is saved as 'pending' for manual processing.
 *
 * Request body (matches store.html exactly — do not rename these fields):
 *   network           — "mtn" | "telecel" | "airteltigo"
 *   phone             — recipient phone number
 *   size              — bundle size in GB
 *   amount            — total amount charged (base + 4% Paystack fee) in GHS
 *   selling_price     — base selling price (before fee) — used for profit calc
 *   payment_reference — Paystack reference (STORE-xxx or GST-xxx)
 *   storeownerid      — UUID of store owner (optional for plain guest)
 *   guest_email       — optional
 *   guest_phone       — optional
 *   status            — 'payment_pending' for pre-registration only
 *
 * Response shape (store.html checks data.status):
 *   { status: true,  code: 200, order_reference, ... }
 *   { status: false, code: 4xx, message }
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Types ──────────────────────────────────────────────────────────────────────
type Provider = "justicedata" | "pensite" | "hubnet" | "sparkdata" | "databosshub";

interface ProviderResult {
  success: boolean;
  data?: any;
  error?: string;
}

interface OrderPayload {
  network: string;
  phone: string;
  bundleSize: number;
  orderId: string;
}

// ─── Response helpers ───────────────────────────────────────────────────────────
function ok(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ status: true, code: status, ...body }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function fail(message: string, code = 400): Response {
  return new Response(JSON.stringify({ status: false, code, message }), {
    status: code,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ─── Phone helpers ──────────────────────────────────────────────────────────────
function normalizePhone(phone: string): string {
  phone = phone.replace(/\D/g, "");
  if (phone.startsWith("233")) phone = "0" + phone.slice(3);
  if (phone.startsWith("+233")) phone = "0" + phone.slice(4);
  if (!phone.startsWith("0")) phone = "0" + phone;
  return phone;
}

function validatePhone(phone: string): boolean {
  return /^0[0-9]{9}$/.test(phone);
}

// ─── Reference generators ───────────────────────────────────────────────────────
function generateOrderReference(isStore: boolean): string {
  const ts  = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${isStore ? "STORE" : "GST"}-${ts}-${rnd}`;
}

function generateExternalOrderId(): string {
  const ts  = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `JD${ts}${rnd}`;
}

// ─── Network mappers ────────────────────────────────────────────────────────────
function mapNetworkJusticeData(network: string, size: number): string {
  if (network === "mtn")        return "MTN";
  if (network === "telecel")    return "TELECEL";
  if (network === "airteltigo") return size >= 15 ? "AIRTELTIGO_BIGTIME" : "AIRTELTIGO_ISHARE";
  return network.toUpperCase();
}

function mapNetworkPensite(network: string, size: number): string {
  if (network === "mtn")        return "YELLO";
  if (network === "telecel")    return "TELECEL";
  if (network === "airteltigo") return size >= 15 ? "AT_BIGTIME" : "AT_PREMIUM";
  return network.toUpperCase();
}

function mapNetworkHubnet(network: string, size: number): string {
  if (network === "mtn")        return "mtn";
  if (network === "telecel")    return "telecel";
  if (network === "airteltigo") return size >= 15 ? "big-time" : "at";
  return network;
}

function mapNetworkSparkData(network: string, size: number): string {
  if (network === "mtn")        return "mtn";
  if (network === "telecel")    return "telecel";
  if (network === "airteltigo") return size >= 15 ? "bigtime" : "ishare";
  return network.toLowerCase();
}

function mapNetworkDataBossHub(network: string): string {
  if (network === "mtn")        return "MTN";
  if (network === "telecel")    return "Telecel";
  if (network === "airteltigo") return "Airteltigo";
  return network;
}

// ─── Provider: Justice Data Shop ────────────────────────────────────────────────
async function placeJusticeDataOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("JUSTICEDATA_API_KEY");
  if (!apiKey) return { success: false, error: "Justice Data API key not configured" };

  const networkKey = mapNetworkJusticeData(payload.network, payload.bundleSize);
  try {
    console.log(`[JusticeData] ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB -> ${payload.phone}`);
    const res = await fetch("https://backend.justicedatashop.com/api/order", {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: payload.phone, size: payload.bundleSize, network: networkKey }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `JusticeData HTTP ${res.status}: ${text}` };
    }
    const data = await res.json();
    if (!data.status) return { success: false, error: `JusticeData error: ${data.message ?? "unknown"}` };
    console.log(`[JusticeData] Success:`, JSON.stringify(data));
    return { success: true, data: { ...data, _provider: "justicedata", _network_key: networkKey } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "JusticeData unknown error" };
  }
}

// ─── Provider: Pensite ──────────────────────────────────────────────────────────
async function placePensiteOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("PENSITE_API_KEY");
  if (!apiKey) return { success: false, error: "Pensite API key not configured" };

  const networkKey = mapNetworkPensite(payload.network, payload.bundleSize);
  try {
    console.log(`[Pensite] ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB -> ${payload.phone}`);
    const res = await fetch("https://pensitegh.com/api/purchase", {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ networkKey, recipient: payload.phone, capacity: payload.bundleSize }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `Pensite HTTP ${res.status}: ${text}` };
    }
    const data = await res.json();
    if (data.status !== "success") return { success: false, error: `Pensite error: ${data.message ?? "unknown"}` };
    console.log(`[Pensite] Success:`, JSON.stringify(data));
    return { success: true, data: { ...data, _provider: "pensite", _network_key: networkKey } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Pensite unknown error" };
  }
}

// ─── Provider: Hubnet ───────────────────────────────────────────────────────────
async function placeHubnetOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("HUBNET_API_KEY");
  if (!apiKey) return { success: false, error: "Hubnet API key not configured" };

  const networkKey = mapNetworkHubnet(payload.network, payload.bundleSize);
  const volumeMB   = String(payload.bundleSize * 1000);
  const hubnetRef  = payload.orderId.substring(0, 25);
  try {
    console.log(`[Hubnet] ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB (${volumeMB}MB) -> ${payload.phone}`);
    const res = await fetch(
      `https://console.hubnet.app/live/api/context/business/transaction/${networkKey}-new-transaction`,
      {
        method: "POST",
        headers: { "token": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ phone: payload.phone, volume: volumeMB, reference: hubnetRef }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `Hubnet HTTP ${res.status}: ${text}` };
    }
    const data = await res.json();
    if (!data.status || data.message !== "0000") {
      return { success: false, error: `Hubnet error: ${data.reason ?? data.code ?? "unknown"}` };
    }
    console.log(`[Hubnet] Success:`, JSON.stringify(data));
    return { success: true, data: { ...data, _provider: "hubnet", _network_key: networkKey } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Hubnet unknown error" };
  }
}

// ─── Provider: Spark Data GH ────────────────────────────────────────────────────
async function placeSparkDataOrder(payload: OrderPayload): Promise<ProviderResult> {
  const username    = Deno.env.get("SPARKDATA_USERNAME");
  const appPassword = Deno.env.get("SPARKDATA_APP_PASSWORD");
  if (!username || !appPassword) return { success: false, error: "Spark Data GH credentials not configured" };

  const credentials = btoa(`${username}:${appPassword}`);
  const networkKey  = mapNetworkSparkData(payload.network, payload.bundleSize);

  try {
    console.log(`[SparkData] ${payload.orderId} — ${payload.network} (${networkKey}) ${payload.bundleSize}GB -> ${payload.phone}`);
    const res = await fetch("https://sparkdatagh.com/wp-json/custom/v1/place-order", {
      method: "POST",
      headers: { "Authorization": `Basic ${credentials}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network:      networkKey,
        recipient:    payload.phone,
        package_size: payload.bundleSize,
        order_id:     payload.orderId,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `SparkData HTTP ${res.status}: ${text}` };
    }
    const data = await res.json();
    if (data.status !== "success") return { success: false, error: `SparkData error: ${data.message ?? "unknown"}` };
    console.log(`[SparkData] Success:`, JSON.stringify(data));
    return { success: true, data: { ...data, _provider: "sparkdata", _network_key: networkKey } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "SparkData unknown error" };
  }
}

// ─── Provider: DataBossHub ──────────────────────────────────────────────────────
async function placeDataBossHubOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("DATABOSSHUB_API_KEY");
  if (!apiKey) return { success: false, error: "DataBossHub API key not configured" };

  const networkKey = mapNetworkDataBossHub(payload.network);
  const dataPlan   = `${payload.bundleSize}GB`;

  try {
    console.log(`[DataBossHub] ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB (${networkKey}/${dataPlan}) -> ${payload.phone}`);

    const res = await fetch("https://bbhubportal.com/api/v1/order", {
      method: "POST",
      headers: {
        "X-API-KEY":    apiKey,
        "Content-Type": "application/json",
        "Accept":       "application/json",
      },
      body: JSON.stringify({
        network:     networkKey,
        data_plan:   dataPlan,
        beneficiary: payload.phone,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      if (res.status === 403) {
        let parsed: any = {};
        try { parsed = JSON.parse(errorText); } catch { /* ignore */ }
        if (parsed.code === "NETWORK_UNAVAILABLE") {
          return { success: false, error: `DataBossHub: ${networkKey} is currently unavailable on their portal` };
        }
      }
      return { success: false, error: `DataBossHub HTTP ${res.status}: ${errorText}` };
    }

    const data = await res.json();
    if (data.status !== "success") {
      return { success: false, error: `DataBossHub error: ${data.message || "Unknown error"}` };
    }

    console.log(`[DataBossHub] Success:`, JSON.stringify(data));
    return {
      success: true,
      data: {
        ...data.data,
        message:        data.data?.message || "Order placed successfully",
        _provider:      "databosshub",
        _network_key:   networkKey,
        _dbh_reference: data.data?.reference,
      },
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "DataBossHub unknown error" };
  }
}

// ─── Single provider dispatcher ─────────────────────────────────────────────────
async function dispatchToProvider(provider: Provider, payload: OrderPayload): Promise<ProviderResult> {
  switch (provider) {
    case "pensite":     return await placePensiteOrder(payload);
    case "hubnet":      return await placeHubnetOrder(payload);
    case "sparkdata":   return await placeSparkDataOrder(payload);
    case "databosshub": return await placeDataBossHubOrder(payload);
    case "justicedata":
    default:            return await placeJusticeDataOrder(payload);
  }
}

// ─── Active provider dispatcher with auto-fallback [FIX-2] ─────────────────────
// If the active provider returns a server-side error (5xx or network error),
// automatically retries with the fallback provider from system_settings.
// Set system_settings key 'fallback_provider' = 'none' to disable auto-fallback.
async function placeOrder(
  supabase: ReturnType<typeof createClient>,
  payload: OrderPayload,
): Promise<ProviderResult & { provider: Provider; usedFallback?: boolean }> {
  const [activeSetting, fallbackSetting] = await Promise.all([
    supabase.from("system_settings").select("value").eq("key", "active_provider").single(),
    supabase.from("system_settings").select("value").eq("key", "fallback_provider").single(),
  ]);

  const activeProvider:   Provider = (activeSetting.data?.value  as Provider) || "justicedata";
  const fallbackProvider: Provider = (fallbackSetting.data?.value as Provider) || "justicedata";
  const fallbackEnabled = fallbackSetting.data?.value !== "none" && fallbackProvider !== activeProvider;

  console.log(`Active provider: ${activeProvider}${fallbackEnabled ? ` | fallback: ${fallbackProvider}` : " | fallback: disabled"}`);

  // ── Primary attempt ────────────────────────────────────────────────────────
  const result = await dispatchToProvider(activeProvider, payload);

  if (result.success) {
    return { ...result, provider: activeProvider };
  }

  console.warn(`[${activeProvider}] failed — order queued for manual processing. Error: ${result.error}`);

  // ── Auto-fallback [FIX-2] ──────────────────────────────────────────────────
  // Only fall back on provider-side failures, not on config/credential errors.
  const isProviderSideFailure =
    result.error?.includes("HTTP 5") ||   // 500/502/503/504
    result.error?.includes("HTTP 429") || // rate-limited
    result.error?.toLowerCase().includes("network error") ||
    result.error?.toLowerCase().includes("fetch failed") ||
    result.error?.toLowerCase().includes("PROVIDER_ERROR");

  if (fallbackEnabled && isProviderSideFailure) {
    console.log(`[${activeProvider}] Attempting fallback to: ${fallbackProvider}`);
    const fallbackResult = await dispatchToProvider(fallbackProvider, payload);

    if (fallbackResult.success) {
      console.log(`[${fallbackProvider}] Fallback succeeded`);
      return { ...fallbackResult, provider: fallbackProvider, usedFallback: true };
    }

    console.warn(`[${fallbackProvider}] Fallback also failed: ${fallbackResult.error}`);
    // Return primary error for the manual queue — include both errors in data
    return {
      success: false,
      error: result.error,
      data: { primary_error: result.error, fallback_error: fallbackResult.error },
      provider: activeProvider,
    };
  }

  return { ...result, provider: activeProvider };
}

// ─── Bundle price resolver ──────────────────────────────────────────────────────
async function resolvePricing(
  supabase: ReturnType<typeof createClient>,
  network: string,
  size: number,
  storeOwnerId: string | null,
  amountPaid: number,
  sellingPriceHint: number,
): Promise<{ sellingPrice: number; baseCost: number } | null> {
  const { data: bundle, error: bundleErr } = await supabase
    .from("bundles")
    .select("id, price")
    .eq("network", network)
    .eq("size", size)
    .eq("active", true)
    .maybeSingle();

  if (bundleErr || !bundle) {
    console.error(`Bundle not found: ${network} ${size}GB`, bundleErr?.message);
    return null;
  }

  const rawBundlePrice = parseFloat(bundle.price);
  if (isNaN(rawBundlePrice) || rawBundlePrice <= 0) {
    console.error(`Bundle ${network} ${size}GB has invalid price: ${bundle.price}`);
    return null;
  }

  let baseCost     = rawBundlePrice;
  let sellingPrice = baseCost;

  if (!storeOwnerId) {
    sellingPrice = sellingPriceHint > 0 ? sellingPriceHint : baseCost;
    console.log(`Guest pricing — selling:${sellingPrice} cost:${baseCost}`);
    return { sellingPrice, baseCost };
  }

  const { data: ubp } = await supabase
    .from("user_bundle_prices")
    .select("custom_price")
    .eq("user_id", storeOwnerId)
    .eq("bundle_id", bundle.id)
    .maybeSingle();

  if (ubp?.custom_price) {
    const parsedCustom = parseFloat(ubp.custom_price);
    if (!isNaN(parsedCustom) && parsedCustom > 0) {
      baseCost = parsedCustom;
      console.log(`Admin custom cost: GH${baseCost}`);
    } else {
      console.warn(`custom_price for owner ${storeOwnerId} is invalid (${ubp.custom_price}) — keeping bundle base price GH${baseCost}`);
    }
  }

  const { data: store } = await supabase
    .from("stores")
    .select("id")
    .eq("owner_id", storeOwnerId)
    .eq("status", "active")
    .maybeSingle();

  if (store) {
    const { data: byStoreId } = await supabase
      .from("store_bundle_prices")
      .select("store_price")
      .eq("store_id", store.id)
      .eq("network", network)
      .eq("size", size)
      .eq("active", true)
      .maybeSingle();

    if (byStoreId?.store_price) {
      const parsedStorePrice = parseFloat(byStoreId.store_price);
      if (!isNaN(parsedStorePrice) && parsedStorePrice > 0) {
        sellingPrice = parsedStorePrice;
        console.log(`Store selling price (store_id): GH${sellingPrice}`);
      } else {
        console.warn(`store_bundle_prices.store_price invalid (${byStoreId.store_price}) — falling back`);
        sellingPrice = sellingPriceHint > 0 ? sellingPriceHint : baseCost;
      }
    } else {
      const { data: byOwnerId } = await supabase
        .from("store_bundle_prices")
        .select("store_price")
        .eq("owner_id", storeOwnerId)
        .eq("network", network)
        .eq("size", size)
        .eq("active", true)
        .maybeSingle();

      if (byOwnerId?.store_price) {
        const parsedOwnerPrice = parseFloat(byOwnerId.store_price);
        if (!isNaN(parsedOwnerPrice) && parsedOwnerPrice > 0) {
          sellingPrice = parsedOwnerPrice;
          console.log(`Store selling price (owner_id fallback): GH${sellingPrice}`);
        } else {
          console.warn(`owner_id store_price invalid (${byOwnerId.store_price}) — using client amount`);
          sellingPrice = sellingPriceHint > 0 ? sellingPriceHint : baseCost;
        }
      } else {
        sellingPrice = sellingPriceHint > 0 ? sellingPriceHint : baseCost;
        console.log(`No store selling price — using client amount: GH${sellingPrice}`);
      }
    }
  } else {
    sellingPrice = sellingPriceHint > 0 ? sellingPriceHint : baseCost;
    console.log(`No active store for owner ${storeOwnerId} — using client amount: GH${sellingPrice}`);
  }

  const computedProfit = parseFloat((sellingPrice - baseCost).toFixed(2));
  if (sellingPrice === baseCost && sellingPrice > 0) {
    console.warn(`Zero-margin order: selling=cost=GH${sellingPrice}. No markup configured for owner ${storeOwnerId}.`);
  }
  console.log(`Pricing resolved — selling:${sellingPrice} cost:${baseCost} profit:${computedProfit}`);
  return { sellingPrice, baseCost };
}

// ─── Main handler ───────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return fail("Method not allowed", 405);

  const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return fail("Server configuration error", 500);

  let body: {
    network: string;
    phone: string;
    size: number | string;
    amount: number | string;
    selling_price?: number | string;
    payment_reference: string;
    storeownerid?: string;
    guest_email?: string;
    guest_phone?: string;
    status?: string; // 'payment_pending' for pre-registration
  };

  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body");
  }

  const {
    network, phone, size, amount, selling_price,
    payment_reference, storeownerid, guest_email, guest_phone,
    status: requestStatus,
  } = body;

  if (!network)           return fail("Missing network");
  if (!phone)             return fail("Missing phone");
  if (!size)              return fail("Missing bundle size");
  if (!amount)            return fail("Missing amount");
  if (!payment_reference) return fail("Missing payment reference");

  const VALID_NETWORKS    = ["mtn", "telecel", "airteltigo"];
  const normalizedNetwork = String(network).toLowerCase();
  if (!VALID_NETWORKS.includes(normalizedNetwork)) {
    return fail(`Invalid network. Must be one of: ${VALID_NETWORKS.join(", ")}`);
  }

  const normalizedPhone = normalizePhone(String(phone));
  if (!validatePhone(normalizedPhone)) return fail("Invalid phone number — must be 10 digits starting with 0");

  const bundleSize = Math.round(parseFloat(String(size)));
  if (isNaN(bundleSize) || bundleSize <= 0) return fail("Invalid bundle size");

  const amountPaid = parseFloat(String(amount));
  if (isNaN(amountPaid) || amountPaid <= 0) return fail("Invalid amount");

  const rawSellingPrice  = selling_price != null ? parseFloat(String(selling_price)) : NaN;
  // [FIX-3] Never derive sellingPriceHint by reversing the 4% fee from amount.
  // If selling_price is missing (e.g. webhook call), pass 0 and let resolvePricing()
  // pull the correct price from the DB exclusively.
  // Reversing the fee caused a double-strip when the webhook re-processed an order
  // whose amount was already the base price (9.30 / 1.04 = 8.94).
  const sellingPriceHint = (!isNaN(rawSellingPrice) && rawSellingPrice > 0)
    ? rawSellingPrice
    : 0;

  const storeOwnerId = storeownerid || null;
  if (storeOwnerId) {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(storeOwnerId)) return fail("Invalid store owner ID format");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── [FIX-1] PRE-REGISTRATION PATH ───────────────────────────────────────────
  // store.html calls this BEFORE opening Paystack with status='payment_pending'.
  // We just save the order skeleton so the webhook always finds it.
  if (requestStatus === "payment_pending") {
    console.log(`Pre-registering order for payment_reference: ${payment_reference}`);

     const preOrderRef = payment_reference;
    // Upsert into guest_orders — safe to call multiple times for same ref
    const { error: guestPreErr } = await supabase
      .from("guest_orders")
     .upsert({
  order_reference:   preOrderRef,
  payment_reference,
  network:           normalizedNetwork,
  sparkdata_network: normalizedNetwork,
  recipient:         normalizedPhone,
        package_size:      bundleSize,
        amount:            sellingPriceHint,
        status:            "payment_pending",
        guest_email:       guest_email ?? null,
        guest_phone:       guest_phone ?? null,
        idempotency_key:   payment_reference,
        payment_verified:  false,
      }, { onConflict: "payment_reference", ignoreDuplicates: true });

    if (guestPreErr) {
      console.warn("Pre-registration guest_orders upsert (non-fatal):", guestPreErr.message);
    }

    // Also pre-register in adminorders so the webhook's idempotency check finds it
    const { error: adminPreErr } = await supabase
      .from("adminorders")
      .upsert({
        order_reference:   preOrderRef,
        payment_reference,
        network:           normalizedNetwork,
        sparkdata_network: normalizedNetwork.toUpperCase(),
        recipient:         normalizedPhone,
        package_size:      bundleSize,
        amount:            sellingPriceHint,
        status:            "payment_pending",
        description:       `${normalizedNetwork.toUpperCase()} ${bundleSize}GB Data Purchase${storeOwnerId ? " (Store)" : " (Guest)"} — awaiting payment`,
       external_response: {
  payment_reference,
  storeownerid:    storeOwnerId ?? null,

  base_cost:
    (
      await resolvePricing(
        supabase,
        normalizedNetwork,
        bundleSize,
        storeOwnerId,
        amountPaid,
        sellingPriceHint,
      )
    )?.baseCost ?? sellingPriceHint,

  pre_registered: true,
  pre_registered_at: new Date().toISOString(),
  },
      }, { onConflict: "payment_reference", ignoreDuplicates: true });

    if (adminPreErr) {
      console.warn("Pre-registration adminorders upsert (non-fatal):", adminPreErr.message);
    }
   await supabase
  .from("transactions")
  .upsert({
    userid: storeOwnerId,

    amount: -sellingPriceHint,

    type: "purchase",

    status: "pending",

    description:
      `${normalizedNetwork.toUpperCase()} ${bundleSize}GB Data Purchase Initialization`,

    details: {
      payment_reference,
      pre_registered: true,
      recipient: normalizedPhone,
    },

    idempotency_key: payment_reference,
  }, {
    onConflict: "idempotency_key",
  });
    console.log(`Pre-registration done: ${preOrderRef} for ref: ${payment_reference}`);
    return ok({ message: "Order pre-registered", order_reference: preOrderRef, pre_registered: true });
  }

  // ── WEBHOOK-ONLY FULFILLMENT MODE ───────────────────────────────────
// IMPORTANT:
// guest-buy-data should NEVER fulfill/provider-process orders anymore.
// It ONLY initializes payment_pending orders.
// Paystack webhook is now the ONLY fulfillment engine.

return ok({
  success: true,
  message: "Order initialized successfully. Awaiting webhook fulfillment.",
  payment_reference,
  status: "payment_pending",
  webhook_fulfillment: true,
});
});