/**
 * api-order — Supabase Edge Function
 *
 * Public API endpoint — called directly by resellers (NOT via user-proxy).
 * Auth: X-API-Key header
 * Method: POST
 * Rate limit: 30 requests per minute
 *
 * Places a data bundle order for a recipient phone number.
 * Deducts from the reseller's wallet immediately upon submission.
 *
 * Request body:
 *   {
 *     phone:   "0241234567",   // 10-digit Ghana number, no country code
 *     size:    5,              // bundle size in GB (must match an active bundle)
 *     network: "mtn"           // mtn | telecel | airteltigo (case-insensitive)
 *   }
 *
 * Success response (200):
 *   {
 *     status: true,
 *     statusCode: 200,
 *     message: "Order placed successfully",
 *     payload: {
 *       order_reference: "API-m9k2d4-ij78kl",
 *       network: "mtn",
 *       size: 5,
 *       phone: "0241234567",
 *       amount_deducted: 22.00,
 *       new_balance: 156.50,
 *       status: "processing"
 *     }
 *   }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateApiKey, checkRateLimit } from "../_shared/api-auth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "x-api-key, content-type, apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const RATE_LIMIT = 30; // requests per minute

// ── Types ─────────────────────────────────────────────────────────────────────
type Provider = "justicedata" | "pensite" | "hubnet" | "sparkdata" | "databosshub";

interface ProviderResult {
  success: boolean;
  data?: any;
  error?: string;
}

interface OrderPayload {
  network:    string;
  phone:      string;
  bundleSize: number;
  orderId:    string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function validatePhone(phone: string): boolean {
  return /^[0-9]{10}$/.test(phone);
}

function generateOrderRef(): string {
  const ts  = Date.now().toString(36);
  const rnd = Math.random().toString(36).substring(2, 8);
  return `API-${ts}-${rnd}`.toUpperCase();
}

// ── Network mappers (mirrors buy-data exactly) ────────────────────────────────
function mapJusticeData(network: string, size: number): string {
  if (network === "mtn")        return "MTN";
  if (network === "telecel")    return "TELECEL";
  if (network === "airteltigo") return size >= 15 ? "AIRTELTIGO_BIGTIME" : "AIRTELTIGO_ISHARE";
  return network.toUpperCase();
}

function mapPensite(network: string, size: number): string {
  if (network === "mtn")        return "YELLO";
  if (network === "telecel")    return "TELECEL";
  if (network === "airteltigo") return size >= 15 ? "AT_BIGTIME" : "AT_PREMIUM";
  return network.toUpperCase();
}

function mapHubnet(network: string, size: number): string {
  if (network === "mtn")        return "mtn";
  if (network === "telecel")    return "telecel";
  if (network === "airteltigo") return size >= 15 ? "big-time" : "at";
  return network;
}

function mapSparkData(network: string, size: number): string {
  if (network === "mtn")        return "mtn";
  if (network === "telecel")    return "telecel";
  if (network === "airteltigo") return size >= 15 ? "bigtime" : "ishare";
  return network.toLowerCase();
}

function mapDataBossHub(network: string): string {
  if (network === "mtn")        return "MTN";
  if (network === "telecel")    return "Telecel";
  if (network === "airteltigo") return "Airteltigo";
  return network;
}

// ── Providers (mirrors buy-data exactly) ──────────────────────────────────────
async function placeJusticeDataOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("JUSTICEDATA_API_KEY");
  if (!apiKey) return { success: false, error: "Justice Data Shop API key not configured" };

  const networkKey = mapJusticeData(payload.network, payload.bundleSize);
  try {
    const res = await fetch("https://backend.justicedatashop.com/api/order", {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: payload.phone, size: payload.bundleSize, network: networkKey }),
    });
    if (!res.ok) return { success: false, error: `JusticeData HTTP ${res.status}: ${await res.text()}` };
    const data = await res.json();
    if (!data.status) return { success: false, error: `JusticeData error: ${data.message || "Unknown"}` };
    return { success: true, data: { ...data, _provider: "justicedata", _network_key: networkKey } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "JusticeData unknown error" };
  }
}

async function placePensiteOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("PENSITE_API_KEY");
  if (!apiKey) return { success: false, error: "Pensite API key not configured" };

  const networkKey = mapPensite(payload.network, payload.bundleSize);
  try {
    const res = await fetch("https://pensitegh.com/api/purchase", {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ networkKey, recipient: payload.phone, capacity: payload.bundleSize }),
    });
    if (!res.ok) return { success: false, error: `Pensite HTTP ${res.status}: ${await res.text()}` };
    const data = await res.json();
    if (data.status !== "success") return { success: false, error: `Pensite error: ${data.message || "Unknown"}` };
    return { success: true, data: { ...data, _provider: "pensite", _network_key: networkKey } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Pensite unknown error" };
  }
}

async function placeHubnetOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("HUBNET_API_KEY");
  if (!apiKey) return { success: false, error: "Hubnet API key not configured" };

  const networkKey = mapHubnet(payload.network, payload.bundleSize);
  const volumeMB   = String(payload.bundleSize * 1000);
  const hubnetRef  = payload.orderId.substring(0, 25);

  try {
    const res = await fetch(
      `https://console.hubnet.app/live/api/context/business/transaction/${networkKey}-new-transaction`,
      {
        method: "POST",
        headers: { token: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ phone: payload.phone, volume: volumeMB, reference: hubnetRef }),
      }
    );
    if (!res.ok) return { success: false, error: `Hubnet HTTP ${res.status}: ${await res.text()}` };
    const data = await res.json();
    if (!data.status || data.message !== "0000") {
      return { success: false, error: `Hubnet error: ${data.reason || data.code || "Unknown"}` };
    }
    return { success: true, data: { ...data, _provider: "hubnet", _network_key: networkKey } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Hubnet unknown error" };
  }
}

async function placeSparkDataOrder(payload: OrderPayload): Promise<ProviderResult> {
  const username    = Deno.env.get("SPARKDATA_USERNAME");
  const appPassword = Deno.env.get("SPARKDATA_APP_PASSWORD");
  if (!username || !appPassword) return { success: false, error: "SparkData credentials not configured" };

  const credentials = btoa(`${username}:${appPassword}`);
  const networkKey  = mapSparkData(payload.network, payload.bundleSize);

  try {
    const res = await fetch("https://sparkdatagh.com/wp-json/custom/v1/place-order", {
      method: "POST",
      headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network:      networkKey,
        recipient:    payload.phone,
        package_size: payload.bundleSize,
        order_id:     payload.orderId,
      }),
    });
    if (!res.ok) return { success: false, error: `SparkData HTTP ${res.status}: ${await res.text()}` };
    const data = await res.json();
    if (data.status !== "success") return { success: false, error: `SparkData error: ${data.message || "Unknown"}` };
    return { success: true, data: { ...data, _provider: "sparkdata", _network_key: networkKey } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "SparkData unknown error" };
  }
}

async function placeDataBossHubOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("DATABOSSHUB_API_KEY");
  if (!apiKey) return { success: false, error: "DataBossHub API key not configured" };

  const networkKey = mapDataBossHub(payload.network);
  const dataPlan   = `${payload.bundleSize}GB`;

  try {
    const res = await fetch("https://bbhubportal.com/api/v1/order", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ network: networkKey, data_plan: dataPlan, beneficiary: payload.phone }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      if (res.status === 403) {
        try {
          const parsed = JSON.parse(errorText);
          if (parsed.code === "NETWORK_UNAVAILABLE") {
            return { success: false, error: `DataBossHub: ${networkKey} is currently unavailable` };
          }
        } catch { /* ignore */ }
      }
      return { success: false, error: `DataBossHub HTTP ${res.status}: ${errorText}` };
    }
    const data = await res.json();
    if (data.status !== "success") return { success: false, error: `DataBossHub error: ${data.message || "Unknown"}` };
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
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "DataBossHub unknown error" };
  }
}

// ── Active provider dispatcher (reads system_settings) ────────────────────────
async function placeOrder(
  supabase: any,
  payload: OrderPayload
): Promise<ProviderResult & { provider: Provider }> {
  const { data: setting } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", "active_provider")
    .single();

  const provider: Provider = (setting?.value as Provider) || "justicedata";
  console.log(`[api-order] Active provider: ${provider}`);

  let result: ProviderResult;

  switch (provider) {
    case "pensite":     result = await placePensiteOrder(payload);     break;
    case "hubnet":      result = await placeHubnetOrder(payload);      break;
    case "sparkdata":   result = await placeSparkDataOrder(payload);   break;
    case "databosshub": result = await placeDataBossHubOrder(payload); break;
    case "justicedata":
    default:            result = await placeJusticeDataOrder(payload); break;
  }

  return { ...result, provider };
}

// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── 1. Validate API key ───────────────────────────────────────────────────
  const auth = await validateApiKey(req, supabase);
  if (!auth.valid) {
    return json({ status: false, statusCode: auth.status, message: auth.message }, auth.status);
  }

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const rate = await checkRateLimit(supabase, auth.keyId, RATE_LIMIT);
  if (!rate.allowed) {
    return json({
      status: false,
      statusCode: 429,
      message: `Rate limit exceeded. Retry after ${rate.retryAfter} seconds.`,
      retry_after_seconds: rate.retryAfter,
    }, 429);
  }

  // ── 3. Parse and validate body ────────────────────────────────────────────
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ status: false, statusCode: 400, message: "Invalid JSON body" }, 400);
  }

  const networkRaw = (body.network as string | undefined)?.toLowerCase().trim();
  const phone      = (body.phone as string | undefined)?.trim();
  const sizeRaw    = body.size;

  if (!networkRaw || !phone || sizeRaw === undefined || sizeRaw === null) {
    return json({ status: false, statusCode: 400, message: "Missing required fields: phone, size, network" }, 400);
  }

  const validNetworks = ["mtn", "telecel", "airteltigo"];
  if (!validNetworks.includes(networkRaw)) {
    return json({ status: false, statusCode: 400, message: "Invalid network. Must be one of: mtn, telecel, airteltigo" }, 400);
  }

  if (!validatePhone(phone!)) {
    return json({ status: false, statusCode: 400, message: "Invalid phone number. Must be exactly 10 digits, no country code." }, 400);
  }

  const bundleSize = Math.round(parseFloat(String(sizeRaw)));
  if (isNaN(bundleSize) || bundleSize <= 0) {
    return json({ status: false, statusCode: 400, message: "Invalid bundle size" }, 400);
  }

  // ── 4. Verify bundle exists and is active ─────────────────────────────────
  const { data: bundleData, error: bundleError } = await supabase
    .from("bundles")
    .select("id, price")
    .eq("network", networkRaw)
    .eq("size", bundleSize)
    .eq("active", true)
    .maybeSingle();

  if (bundleError || !bundleData) {
    return json({ status: false, statusCode: 404, message: "Bundle not available for this network and size" }, 404);
  }

  // ── 5. Determine price (custom price → base price) ────────────────────────
  // SECURITY: Price always comes from DB, never from the API request body.
  const basePrice = parseFloat(bundleData.price);
  let finalPrice  = basePrice;
  let priceSource = "base";

  const { data: customPrice } = await supabase
    .from("user_bundle_prices")
    .select("custom_price")
    .eq("user_id", auth.userId)
    .eq("bundle_id", bundleData.id)
    .maybeSingle();

  if (customPrice?.custom_price) {
    const parsed = parseFloat(customPrice.custom_price);
    if (!isNaN(parsed) && parsed > 0) {
      finalPrice  = parsed;
      priceSource = "admin_custom";
    }
  }

  console.log(`[api-order] Price: GH₵${finalPrice} (source: ${priceSource}) for user ${auth.userId}`);

  // ── 6. Load and validate wallet ───────────────────────────────────────────
  const { data: wallet, error: walletError } = await supabase
    .from("wallets")
    .select("id, balance, version, is_frozen")
    .eq("user_id", auth.userId)
    .single();

  if (walletError || !wallet) {
    return json({ status: false, statusCode: 400, message: "Wallet not found" }, 400);
  }

  if (wallet.is_frozen) {
    return json({ status: false, statusCode: 403, message: "Your wallet is frozen. Please contact support." }, 403);
  }

  const currentBalance = parseFloat(wallet.balance);
  if (currentBalance < finalPrice) {
    return json({
      status: false,
      statusCode: 400,
      message: `Insufficient balance. Required: GH₵${finalPrice.toFixed(2)}, Available: GH₵${currentBalance.toFixed(2)}`,
    }, 400);
  }

  // ── 7. Generate order reference ───────────────────────────────────────────
  const orderRef = generateOrderRef();

  // ── 8. Deduct wallet (optimistic lock on version) ─────────────────────────
  const newBalance = parseFloat((currentBalance - finalPrice).toFixed(2));
  const { error: walletUpdateError } = await supabase
    .from("wallets")
    .update({
      balance:    newBalance,
      version:    wallet.version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", wallet.id)
    .eq("version", wallet.version); // fails if another request already updated

  if (walletUpdateError) {
    console.error("[api-order] Wallet update failed (possible concurrent request):", walletUpdateError.message);
    return json({ status: false, statusCode: 409, message: "Wallet update failed — possible concurrent request. Please retry." }, 409);
  }

  // ── 9. Place order via active provider ────────────────────────────────────
  const orderResult = await placeOrder(supabase, {
    network:    networkRaw,
    phone:      phone!,
    bundleSize,
    orderId:    orderRef,
  });

  const apiSuccess     = orderResult.success;
  const activeProvider = orderResult.provider;
  const description    = `${networkRaw.toUpperCase()} ${bundleSize}GB Data Purchase (API)`;

  // Always use 'processing' — whether the provider accepted instantly or
  // this needs manual fulfilment is our internal concern, never the reseller's.
  const orderStatus = "processing";

  if (!apiSuccess) {
    // Provider failed — log internally for admin attention.
    // Wallet is NOT refunded — we still need those funds to fulfil manually.
    console.warn(`[api-order] ${activeProvider} failed — flagged for manual processing. Error: ${orderResult.error}`);
  }

  // ── 10. Record in api_orders ──────────────────────────────────────────────
  const { error: apiOrderError } = await supabase.from("api_orders").insert({
    api_key_id:       auth.keyId,
    user_id:          auth.userId,
    order_reference:  orderRef,
    network:          networkRaw,
    phone:            phone!,
    size:             bundleSize,
    amount:           finalPrice,
    status:           orderStatus,
    provider:         activeProvider,
    provider_ref:     orderResult.data?._dbh_reference || orderResult.data?.payload?.id || null,
    manual_fallback:  !apiSuccess,
    external_response: {
      provider_response: apiSuccess ? orderResult.data : null,
      provider_error:    !apiSuccess ? orderResult.error : null,
      base_price:        basePrice,
      final_price:       finalPrice,
      price_source:      priceSource,
      flagged_at:        !apiSuccess ? new Date().toISOString() : null,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (apiOrderError) {
    console.error("[api-order] api_orders insert failed:", apiOrderError.message);
  }

  // ── 11. Record in adminorders (operator visibility) ───────────────────────
  const { error: adminOrderError } = await supabase.from("adminorders").insert({
    userid:            auth.userId,
    order_reference:   orderRef,
    payment_reference: null,
    network:           networkRaw,
    sparkdata_network: orderResult.data?._network_key || networkRaw,
    recipient:         phone!,
    package_size:      bundleSize,
    amount:            finalPrice,
    status:            orderStatus,
    description,
    external_response: {
      source:            "api",
      api_key_id:        auth.keyId,
      provider:          activeProvider,
      manual_fallback:   !apiSuccess,
      provider_response: apiSuccess ? orderResult.data : null,
      provider_error:    !apiSuccess ? orderResult.error : null,
      base_cost:         basePrice,
      selling_price:     finalPrice,
      profit:            parseFloat((finalPrice - basePrice).toFixed(2)),
      price_source:      priceSource,
      flagged_at:        !apiSuccess ? new Date().toISOString() : null,
    },
  });

  if (adminOrderError) {
    console.error("[api-order] adminorders insert failed:", adminOrderError.message);
  }

  // ── 12. Record in transactions ────────────────────────────────────────────
  await supabase.from("transactions").insert({
    userid:      auth.userId,
    amount:      -finalPrice,
    type:        "purchase",
    status:      orderStatus,
    description,
    details: {
      source:          "api",
      network:         networkRaw,
      phone_number:    phone!,
      bundle_size:     bundleSize,
      bundle_price:    finalPrice,
      base_price:      basePrice,
      price_source:    priceSource,
      order_reference: orderRef,
      provider:        activeProvider,
      balance_before:  currentBalance,
      balance_after:   newBalance,
      manual_fallback: !apiSuccess,
    },
  });

  // ── 13. Return response ───────────────────────────────────────────────────
  // Always success — internal provider state is never exposed to the reseller.
  return json({
    status:     true,
    statusCode: 200,
    message:    "Order placed successfully",
    payload: {
      order_reference: orderRef,
      network:         networkRaw,
      size:            bundleSize,
      phone:           phone!,
      amount_deducted: finalPrice,
      new_balance:     newBalance,
      status:          "processing",
    },
  });
});