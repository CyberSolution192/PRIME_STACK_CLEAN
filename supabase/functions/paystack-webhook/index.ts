/**
 * paystack-webhook  —  Supabase Edge Function
 *
 * SAFETY NET for the entire payment pipeline.
 *
 * Reference prefix routing (single source of truth):
 *   WALLET-  → wallet top-up (verify-paystack flow)
 *   GST-     → guest/store purchase (guest-buy-data flow)
 *   STORE-   → legacy store prefix (kept for backward compat)
 *   PAY-     → legacy store prefix (kept for backward compat)
 *   TXN-     → registered user purchase (buy-data flow)
 *
 * KEY FIX (2026-04):
    .eq("external_response->>payment_reference", reference)
 *   to      .eq("external_response->>payment_reference", reference)
 *   The old .filter() call silently returned no rows in the Supabase JS client,
 *   causing every PAY- / STORE- order to look "missing" and create a ghost
 *   recovery record even though guest-buy-data had already fulfilled the order.
 *
 * Deploy:
 *   supabase functions deploy paystack-webhook --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
type Provider =
  | "justicedata"
  | "pensite"
  | "hubnet"
  | "sparkdata"
  | "databosshub";

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

function generateExternalOrderId(): string {
  const ts  = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).substring(2, 8).toUpperCase();

  return `JD${ts}${rnd}`;
}
function mapNetworkJusticeData(
  network: string,
  size: number
): string {

  if (network === "mtn") {
    return "MTN";
  }

  if (network === "telecel") {
    return "TELECEL";
  }

  if (network === "airteltigo") {
    return size >= 15
      ? "AIRTELTIGO_BIGTIME"
      : "AIRTELTIGO_ISHARE";
  }

  return network.toUpperCase();
}

function mapNetworkPensite(
  network: string,
  size: number
): string {

  if (network === "mtn") {
    return "YELLO";
  }

  if (network === "telecel") {
    return "TELECEL";
  }

  if (network === "airteltigo") {
    return size >= 15
      ? "AT_BIGTIME"
      : "AT_PREMIUM";
  }

  return network.toUpperCase();
}

function mapNetworkHubnet(
  network: string,
  size: number
): string {

  if (network === "mtn") {
    return "mtn";
  }

  if (network === "telecel") {
    return "telecel";
  }

  if (network === "airteltigo") {
    return size >= 15
      ? "big-time"
      : "at";
  }

  return network;
}

function mapNetworkSparkData(
  network: string,
  size: number
): string {

  if (network === "mtn") {
    return "mtn";
  }

  if (network === "telecel") {
    return "telecel";
  }

  if (network === "airteltigo") {
    return size >= 15
      ? "bigtime"
      : "ishare";
  }

  return network.toLowerCase();
}

function mapNetworkDataBossHub(
  network: string
): string {

  if (network === "mtn") {
    return "MTN";
  }

  if (network === "telecel") {
    return "Telecel";
  }

  if (network === "airteltigo") {
    return "Airteltigo";
  }

  return network;
}
async function placeJusticeDataOrder(
  payload: OrderPayload
): Promise<ProviderResult> {

  const apiKey =
    Deno.env.get("JUSTICEDATA_API_KEY");

  if (!apiKey) {
    return {
      success: false,
      error: "Justice Data API key not configured"
    };
  }

  const networkKey =
    mapNetworkJusticeData(
      payload.network,
      payload.bundleSize
    );

  try {

    console.log(
      `[JusticeData] ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB -> ${payload.phone}`
    );

    const res = await fetch(
      "https://backend.justicedatashop.com/api/order",
      {
        method: "POST",

        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          phone: payload.phone,
          size: payload.bundleSize,
          network: networkKey
        }),
      }
    );

    if (!res.ok) {

      const text = await res.text();

      return {
        success: false,
        error: `JusticeData HTTP ${res.status}: ${text}`
      };
    }

    const data = await res.json();

    if (!data.status) {
      return {
        success: false,
        error: `JusticeData error: ${data.message ?? "unknown"}`
      };
    }

    console.log(
      `[JusticeData] Success:`,
      JSON.stringify(data)
    );

    return {
      success: true,
      data: {
        ...data,
        _provider: "justicedata",
        _network_key: networkKey
      }
    };

  } catch (e) {

    return {
      success: false,
      error:
        e instanceof Error
          ? e.message
          : "JusticeData unknown error"
    };
  }
}
async function placePensiteOrder(
  payload: OrderPayload
): Promise<ProviderResult> {

  const apiKey =
    Deno.env.get("PENSITE_API_KEY");

  if (!apiKey) {
    return {
      success: false,
      error: "Pensite API key not configured"
    };
  }

  const networkKey =
    mapNetworkPensite(
      payload.network,
      payload.bundleSize
    );

  try {

    console.log(
      `[Pensite] ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB -> ${payload.phone}`
    );

    const res = await fetch(
      "https://pensitegh.com/api/purchase",
      {
        method: "POST",

        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          networkKey,
          recipient: payload.phone,
          capacity: payload.bundleSize
        }),
      }
    );

    if (!res.ok) {

      const text = await res.text();

      return {
        success: false,
        error: `Pensite HTTP ${res.status}: ${text}`
      };
    }

    const data = await res.json();

    if (data.status !== "success") {
      return {
        success: false,
        error: `Pensite error: ${data.message ?? "unknown"}`
      };
    }

    console.log(
      `[Pensite] Success:`,
      JSON.stringify(data)
    );

    return {
      success: true,
      data: {
        ...data,
        _provider: "pensite",
        _network_key: networkKey
      }
    };

  } catch (e) {

    return {
      success: false,
      error:
        e instanceof Error
          ? e.message
          : "Pensite unknown error"
    };
  }
}
async function placeHubnetOrder(
  payload: OrderPayload
): Promise<ProviderResult> {

  const apiKey =
    Deno.env.get("HUBNET_API_KEY");

  if (!apiKey) {
    return {
      success: false,
      error: "Hubnet API key not configured"
    };
  }

  const networkKey =
    mapNetworkHubnet(
      payload.network,
      payload.bundleSize
    );

  const volumeMB =
    String(payload.bundleSize * 1000);

  const hubnetRef =
    payload.orderId.substring(0, 25);

  try {

    console.log(
      `[Hubnet] ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB -> ${payload.phone}`
    );

    const res = await fetch(
      `https://console.hubnet.app/live/api/context/business/transaction/${networkKey}-new-transaction`,
      {
        method: "POST",

        headers: {
          "token": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          phone: payload.phone,
          volume: volumeMB,
          reference: hubnetRef
        }),
      }
    );

    if (!res.ok) {

      const text = await res.text();

      return {
        success: false,
        error: `Hubnet HTTP ${res.status}: ${text}`
      };
    }

    const data = await res.json();

    if (
      !data.status ||
      data.message !== "0000"
    ) {
      return {
        success: false,
        error:
          `Hubnet error: ${
            data.reason ??
            data.code ??
            "unknown"
          }`
      };
    }

    console.log(
      `[Hubnet] Success:`,
      JSON.stringify(data)
    );

    return {
      success: true,
      data: {
        ...data,
        _provider: "hubnet",
        _network_key: networkKey
      }
    };

  } catch (e) {

    return {
      success: false,
      error:
        e instanceof Error
          ? e.message
          : "Hubnet unknown error"
    };
  }
}
async function placeSparkDataOrder(
  payload: OrderPayload
): Promise<ProviderResult> {

  const username =
    Deno.env.get("SPARKDATA_USERNAME");

  const appPassword =
    Deno.env.get("SPARKDATA_APP_PASSWORD");

  if (!username || !appPassword) {
    return {
      success: false,
      error: "Spark Data GH credentials not configured"
    };
  }

  const credentials =
    btoa(`${username}:${appPassword}`);

  const networkKey =
    mapNetworkSparkData(
      payload.network,
      payload.bundleSize
    );

  try {

    console.log(
      `[SparkData] ${payload.orderId} — ${payload.network} (${networkKey}) ${payload.bundleSize}GB -> ${payload.phone}`
    );

    const res = await fetch(
      "https://sparkdatagh.com/wp-json/custom/v1/place-order",
      {
        method: "POST",

        headers: {
          "Authorization": `Basic ${credentials}`,
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          network: networkKey,
          recipient: payload.phone,
          package_size: payload.bundleSize,
          order_id: payload.orderId,
        }),
      }
    );

    if (!res.ok) {

      const text = await res.text();

      return {
        success: false,
        error: `SparkData HTTP ${res.status}: ${text}`
      };
    }

    const data = await res.json();

    if (data.status !== "success") {
      return {
        success: false,
        error:
          `SparkData error: ${
            data.message ?? "unknown"
          }`
      };
    }

    console.log(
      `[SparkData] Success:`,
      JSON.stringify(data)
    );

    return {
      success: true,
      data: {
        ...data,
        _provider: "sparkdata",
        _network_key: networkKey
      }
    };

  } catch (e) {

    return {
      success: false,
      error:
        e instanceof Error
          ? e.message
          : "SparkData unknown error"
    };
  }
}
async function placeDataBossHubOrder(
  payload: OrderPayload
): Promise<ProviderResult> {

  const apiKey =
    Deno.env.get("DATABOSSHUB_API_KEY");

  if (!apiKey) {
    return {
      success: false,
      error: "DataBossHub API key not configured"
    };
  }

  const networkKey =
    mapNetworkDataBossHub(
      payload.network
    );

  const dataPlan =
    `${payload.bundleSize}GB`;

  try {

    console.log(
      `[DataBossHub] ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB (${networkKey}/${dataPlan}) -> ${payload.phone}`
    );

    const res = await fetch(
      "https://bbhubportal.com/api/v1/order",
      {
        method: "POST",

        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },

        body: JSON.stringify({
          network: networkKey,
          data_plan: dataPlan,
          beneficiary: payload.phone,
        }),
      }
    );

    if (!res.ok) {

      const errorText =
        await res.text();

      if (res.status === 403) {

        let parsed: any = {};

        try {
          parsed = JSON.parse(errorText);
        } catch {
        }

        if (
          parsed.code ===
          "NETWORK_UNAVAILABLE"
        ) {
          return {
            success: false,
            error:
              `DataBossHub: ${networkKey} is currently unavailable on their portal`
          };
        }
      }

      return {
        success: false,
        error:
          `DataBossHub HTTP ${res.status}: ${errorText}`
      };
    }

    const data = await res.json();

    if (data.status !== "success") {
      return {
        success: false,
        error:
          `DataBossHub error: ${
            data.message ||
            "Unknown error"
          }`
      };
    }

    console.log(
      `[DataBossHub] Success:`,
      JSON.stringify(data)
    );

    return {
      success: true,
      data: {
        ...data.data,
        message:
          data.data?.message ||
          "Order placed successfully",

        _provider: "databosshub",
        _network_key: networkKey,
        _dbh_reference:
          data.data?.reference,
      },
    };

  } catch (e) {

    return {
      success: false,
      error:
        e instanceof Error
          ? e.message
          : "DataBossHub unknown error"
    };
  }
}
async function dispatchToProvider(
  provider: Provider,
  payload: OrderPayload
): Promise<ProviderResult> {

  switch (provider) {

    case "pensite":
      return await placePensiteOrder(payload);

    case "hubnet":
      return await placeHubnetOrder(payload);

    case "sparkdata":
      return await placeSparkDataOrder(payload);

    case "databosshub":
      return await placeDataBossHubOrder(payload);

    case "justicedata":
    default:
      return await placeJusticeDataOrder(payload);
  }
}
// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonErr(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * SECURITY: Verify the Paystack HMAC-SHA512 webhook signature.
 *
 * Paystack signs every webhook with HMAC-SHA512(rawBody, secretKey) and
 * sends the hex digest in the x-paystack-signature header. Without this
 * check, anyone who knows the webhook URL can POST a fake charge.success
 * event and credit wallets for free. This MUST run before req.json() is
 * called — we need the raw bytes of the body to compute the digest.
 *
 * The re-verify call to Paystack's REST API is kept as a second layer of
 * defence, but HMAC must always be the first gate.
 */
async function verifyPaystackSignature(
  rawBody: string,
  signature: string,
  secretKey: string,
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secretKey);
    const bodyData = encoder.encode(rawBody);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-512" },
      false,
      ["sign"],
    );

    const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, bodyData);
    const computedHex = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time comparison to prevent timing attacks
    if (computedHex.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < computedHex.length; i++) {
      diff |= computedHex.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  } catch (e) {
    console.error("HMAC verification error:", e);
    return false;
  }
}

// Re-verify a reference directly with Paystack REST API.
// Second layer of defence — kept in addition to HMAC, not instead of it.
async function reVerifyWithPaystack(
  reference: string,
  secretKey: string,
): Promise<{ ok: boolean; data?: any }> {
  try {
    const res = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    const json = await res.json();
    if (json?.status && json?.data?.status === "success") {
      return { ok: true, data: json.data };
    }
    return { ok: false, data: json };
  } catch (e) {
    return { ok: false };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method !== "POST") {
    return jsonErr({ message: "Method not allowed" }, 405);
  }

  const PAYSTACK_SECRET_KEY       = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
  const SUPABASE_URL              = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!PAYSTACK_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing required env vars");
    return jsonOk({ message: "Configuration error -- logged" });
  }

  // ── SECURITY: HMAC-SHA512 signature check ─────────────────────────────────
  // Read raw body text FIRST (before .json()) so we can compute the HMAC.
  // Paystack sends the digest in x-paystack-signature. Reject anything that
  // doesn't match — this is the primary gate against forged webhook events.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return jsonOk({ message: "Could not read request body" });
  }

  const paystackSignature = req.headers.get("x-paystack-signature") ?? "";
  if (!paystackSignature) {
    console.error("Missing x-paystack-signature header — rejecting request");
    return jsonErr({ message: "Forbidden" }, 403);
  }

  const signatureValid = await verifyPaystackSignature(rawBody, paystackSignature, PAYSTACK_SECRET_KEY);
  if (!signatureValid) {
    console.error("Invalid Paystack HMAC signature — rejecting request");
    return jsonErr({ message: "Forbidden" }, 403);
  }

  console.log("✅ Paystack HMAC signature verified");

  // Now safe to parse JSON
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    console.error("Invalid JSON body");
    return jsonOk({ message: "Invalid JSON" });
  }

  if (event?.event !== "charge.success") {
    console.log(`Ignoring event type: ${event?.event}`);
    return jsonOk({ message: "Event type ignored" });
  }

  const reference: string = event?.data?.reference ?? "";
  const email: string     = event?.data?.customer?.email ?? "";
  const metadata          = event?.data?.metadata ?? {};

  console.log(`charge.success received -- ref: ${reference}, email: ${email}`);

  if (!reference) {
    console.error("No reference in event payload");
    return jsonOk({ message: "No reference" });
  }

  // Re-verify with Paystack REST API — primary security check
  const verification = await reVerifyWithPaystack(reference, PAYSTACK_SECRET_KEY);
  if (!verification.ok) {
    console.error("Re-verification failed -- not recording:", verification.data);
    return jsonOk({ message: "Re-verification failed -- not recording" });
  }

  const paystackData = verification.data;
  const amountGHS    = paystackData.amount / 100;
  console.log(`Re-verified: GHC${amountGHS} from ${email}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Idempotency: check webhook_events to avoid double-processing
  const { data: existingEvent } = await supabase
    .from("webhook_events")
    .select("id, processed")
    .eq("reference", reference)
    .maybeSingle();

  if (existingEvent?.processed) {
    console.log(`Already processed webhook for ref: ${reference}`);
    return jsonOk({ message: "Already processed" });
  }

  await supabase
    .from("webhook_events")
    .upsert(
      {
        reference,
        event_type: "charge.success",
        email,
        amount: amountGHS,
        paystack_data: paystackData,
        processed: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "reference" },
    );

  // ── Route by reference prefix ──────────────────────────────────────────────
  const isWalletTopup = reference.startsWith("WALLET-");
  const isGuestOrder  = reference.startsWith("GST-")
                     || reference.startsWith("STORE-")
                     || reference.startsWith("PAY-");
  const isUserOrder   = reference.startsWith("TXN-");

  if (isWalletTopup) {
    console.log(`Handling wallet top-up: ${reference}`);
    await handleWalletTopup({ supabase, reference, email, amountGHS, paystackData, metadata });
    await markWebhookProcessed(supabase, reference);
    return jsonOk({ message: "Wallet top-up reconciled" });
  }

  if (isGuestOrder) {
    console.log(`Handling guest/store order: ${reference}`);
    try {
  await handleGuestOrder({
    supabase,
    reference,
    amountGHS,
    paystackData,
    metadata
  });

  await markWebhookProcessed(supabase, reference);

  return jsonOk({
    message: "Guest/store order reconciled"
  });

} catch (error) {

  console.error(
    "GUEST ORDER WEBHOOK CRASH:",
    error
  );

  return jsonOk({
    message: "Webhook crashed"
  });
}
  }

  if (isUserOrder) {
    console.log(`Registered user order ref: ${reference} -- checking adminorders`);
    const { data: order } = await supabase
      .from("adminorders")
      .select("id")
      .eq("order_reference", reference)
      .maybeSingle();

    if (order) {
      console.log(`Order already recorded for ref: ${reference}`);
    } else {
      console.warn(`User order ${reference} not in adminorders -- writing orphan`);
      await writeOrphan(supabase, reference, amountGHS, paystackData, "user_order_missing");
    }
    await markWebhookProcessed(supabase, reference);
    return jsonOk({ message: "User order checked" });
  }

  // Unknown reference pattern — write orphan for admin review
  console.warn(`Unknown reference pattern: ${reference}`);
  await writeOrphan(supabase, reference, amountGHS, paystackData, "unknown_pattern");
  await markWebhookProcessed(supabase, reference);
  return jsonOk({ message: "Orphan recorded -- requires manual review" });
});

// ── Sub-handlers ──────────────────────────────────────────────────────────────

async function handleWalletTopup({
  supabase, reference, email, amountGHS, paystackData, metadata,
}: any) {
  let userId: string | null = null;

  const { data: pv } = await supabase
    .from("paystack_verifications")
    .select("user_id, processed, status")
    .eq("reference", reference)
    .maybeSingle();

  if (pv?.processed) {
    console.log(`paystack_verifications already processed: ${reference}`);
    return;
  }

  if (pv?.user_id) {
    userId = pv.user_id;
  } else if (metadata?.user_id) {
    userId = metadata.user_id;
  } else if (email) {
    const { data: u } = await supabase
      .from("auth.users")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    userId = u?.id ?? null;
  }

  if (!userId) {
    console.error(`Cannot resolve user_id for wallet top-up: ${reference}`);
    await writeOrphan(supabase, reference, amountGHS, paystackData, "wallet_topup_no_user");
    return;
  }

  const { error: pvError } = await supabase
    .from("paystack_verifications")
    .upsert(
      {
        user_id: userId,
        reference,
        amount: amountGHS,
        status: "success",
        paystack_response: paystackData,
        processed: false,
        verification_attempts: 1,
        last_verification_attempt: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "reference" },
    );

  if (pvError) {
    console.error("paystack_verifications upsert error:", pvError);
  }

   const { data: existingTxn } = await supabase
  .from("transactions")
  .select("id")
  .eq("userid", userId)
  .eq("details->>payment_reference", reference)
  .maybeSingle();

  if (existingTxn) {
    console.log(`Wallet transaction already exists for: ${reference}`);
    await supabase
      .from("paystack_verifications")
      .update({ processed: true, status: "credited", updated_at: new Date().toISOString() })
      .eq("reference", reference);
    return;
  }

  let creditAmount: number = amountGHS;
  const metaBundleAmount     = metadata?.bundle_amount     ?? paystackData?.metadata?.bundle_amount;
  const metaProcessingCharge = metadata?.processing_charge ?? paystackData?.metadata?.processing_charge;

  if (metaBundleAmount !== undefined && metaBundleAmount !== null && metaBundleAmount !== "") {
    creditAmount = parseFloat(String(metaBundleAmount));
    console.log(`Crediting bundle_amount: GH₵${creditAmount} (Paystack total: GH₵${amountGHS})`);
  } else if (metaProcessingCharge !== undefined && metaProcessingCharge !== null && metaProcessingCharge !== "") {
    creditAmount = parseFloat((amountGHS - parseFloat(String(metaProcessingCharge))).toFixed(2));
    console.log(`Derived credit: GH₵${creditAmount} (GH₵${amountGHS} - GH₵${metaProcessingCharge})`);
  } else {
    console.warn(`No bundle_amount/processing_charge in metadata for ${reference} — crediting full GH₵${amountGHS}`);
  }

  if (isNaN(creditAmount) || creditAmount <= 0) {
    await writeOrphan(supabase, reference, amountGHS, paystackData, "wallet_invalid_credit_amount");
    return;
  }

  console.log(`Crediting wallet for user ${userId} -- GH₵${creditAmount} (of GH₵${amountGHS} paid)`);
  // NEW — matches the secure function signature
  const { data: rpcResult, error: rpcError } = await supabase.rpc("process_paystack_payment", {
  p_user_id:       userId,
  p_reference:     reference,    // ← p_reference now second
  p_amount:        creditAmount,
  p_paystack_data: paystackData,
});

  if (rpcError || !rpcResult?.success) {
    console.error("process_paystack_payment RPC failed:", rpcError ?? rpcResult);
    await supabase
      .from("paystack_verifications")
      .update({ status: "rpc_failed", updated_at: new Date().toISOString() })
      .eq("reference", reference);
    await writeOrphan(supabase, reference, amountGHS, paystackData, "wallet_rpc_failed");
    return;
  }

  await supabase
    .from("paystack_verifications")
    .update({ processed: true, status: "credited", updated_at: new Date().toISOString() })
    .eq("reference", reference);

  console.log(`Wallet credited via webhook for: ${reference}`);
}
 
 async function placeOrder(
  supabase: ReturnType<typeof createClient>,
  payload: OrderPayload,
): Promise<
  ProviderResult & {
    provider: Provider;
    usedFallback?: boolean;
  }
> {

  const [
    activeSetting,
    fallbackSetting
  ] = await Promise.all([

    supabase
      .from("system_settings")
      .select("value")
      .eq("key", "active_provider")
      .single(),

    supabase
      .from("system_settings")
      .select("value")
      .eq("key", "fallback_provider")
      .single(),
  ]);

  const activeProvider: Provider =
    (activeSetting.data?.value as Provider)
    || "justicedata";

  const fallbackProvider: Provider =
    (fallbackSetting.data?.value as Provider)
    || "justicedata";

  const fallbackEnabled =
    fallbackSetting.data?.value !== "none"
    && fallbackProvider !== activeProvider;

  console.log(
    `Active provider: ${activeProvider}${
      fallbackEnabled
        ? ` | fallback: ${fallbackProvider}`
        : " | fallback: disabled"
    }`
  );

  // PRIMARY ATTEMPT
  const result =
    await dispatchToProvider(
      activeProvider,
      payload
    );

  if (result.success) {
    return {
      ...result,
      provider: activeProvider
    };
  }

  console.warn(
    `[${activeProvider}] failed — Error: ${result.error}`
  );

  // AUTO FALLBACK
  const isProviderSideFailure =
    result.error?.includes("HTTP 5") ||
    result.error?.includes("HTTP 429") ||
    result.error?.toLowerCase().includes("network error") ||
    result.error?.toLowerCase().includes("fetch failed") ||
    result.error?.toLowerCase().includes("PROVIDER_ERROR");

  if (
    fallbackEnabled &&
    isProviderSideFailure
  ) {

    console.log(
      `[${activeProvider}] Attempting fallback to: ${fallbackProvider}`
    );

    const fallbackResult =
      await dispatchToProvider(
        fallbackProvider,
        payload
      );

    if (fallbackResult.success) {

      console.log(
        `[${fallbackProvider}] Fallback succeeded`
      );

      return {
        ...fallbackResult,
        provider: fallbackProvider,
        usedFallback: true,
      };
    }

    console.warn(
      `[${fallbackProvider}] Fallback also failed: ${fallbackResult.error}`
    );

    return {
      success: false,
      error: result.error,
      data: {
        primary_error: result.error,
        fallback_error: fallbackResult.error,
      },
      provider: activeProvider,
    };
  }

  return {
    ...result,
    provider: activeProvider,
  };
}
async function handleGuestOrder({
  supabase, reference, amountGHS, paystackData, metadata,
}: any) {
  console.log("NEW WEBHOOK BUILD ACTIVE");
  console.log("LOOKING UP PAYMENT REF:", reference);
  // ── Check if order already exists — try all three reference paths ──────────
  // Path 1: order_reference = reference (direct match)
  // Path 2: payment_reference column = reference (top-level column, added 2026-05)
  // Path 3: external_response->>'payment_reference' = reference (older records in JSONB)
  // Uses .filter() for JSONB path — .eq() does not handle ->> operators correctly.
let { data: existingOrder, error: orderLookupError } = await supabase
  .from("adminorders")
  .select(`
    id,
    status,
    network,
    recipient,
    package_size,
    amount,
    external_response
  `)
  .eq("payment_reference", reference)
  .maybeSingle();

if (orderLookupError) {
  console.error(
    "ORDER LOOKUP ERROR:",
    orderLookupError
  );

  return;
}
 // ── SAFE ORDER LOOKUP + ATOMIC LOCKING ─────────────────────────────

 if (!existingOrder) {
  await supabase
  .from("guest_orders")
  .upsert({
    guest_email:
      paystackData?.customer?.email || null,

    network:
      metadata?.network || "mtn",

    sparkdata_network:
      metadata?.network || "mtn",

    recipient:
      metadata?.recipient ||
      metadata?.phone,

    package_size:
      Number(metadata?.bundle_size || 0),

    amount:
      Number(
        metadata?.bundle_amount ||
        amountGHS
      ),

    status: "pending",

    order_reference: reference,

    payment_reference: reference,

    payment_verified: true,

    payment_verified_at:
      new Date().toISOString(),

    paystack_response:
      paystackData,

    description:
      `${String(
        metadata?.bundle_name || "Data"
      )} Purchase`,

    created_at:
      new Date().toISOString(),

    updated_at:
      new Date().toISOString(),
  });

  console.error(
    "ORDER LOOKUP FAILED:",
    reference
  );

  const reconstructedOrder = {
    order_reference: reference,
    payment_reference: reference,

    network:
      metadata?.network || "mtn",
      sparkdata_network:
      metadata?.network || "mtn",

    recipient:
      metadata?.recipient ||
      metadata?.phone ||
      metadata?.recipient_phone,

    package_size:
      Number(metadata?.bundle_size || 0),

    amount:
      Number(
        metadata?.bundle_amount ||
        amountGHS
      ),

    status: "pending",

    description:
      `${String(
        metadata?.bundle_name || "Data"
      )} Purchase`,

    external_response: {
      reconstructed_from_webhook: true,
      paystack_metadata: metadata,
    },

    processing_lock: false,

    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const {
    data: insertedOrder,
    error: insertError
  } = await supabase
    .from("adminorders")
    .insert(reconstructedOrder)
    .select()
    .single();

  if (insertError || !insertedOrder) {

    console.error(
      "RECONSTRUCTION FAILED:",
      insertError
    );

    await writeOrphan(
      supabase,
      reference,
      amountGHS,
      paystackData,
      "reconstruction_failed"
    );

    return;
  }

  console.log(
    "ORDER RECONSTRUCTED:",
    reference
  );

  existingOrder = insertedOrder;
}

const sellingPrice = Number(existingOrder.amount || 0);

const baseCost =
  Number(
    existingOrder.external_response?.base_cost
  ) || sellingPrice;

console.log(
  "ORDER FOUND:",
  existingOrder
);
const { data: existingTxn } = await supabase
  .from("transactions")
  .select("id")
  .eq(
    "details->>payment_reference",
    reference
  )
  .maybeSingle();
if (!existingTxn) {

  await supabase
    .from("transactions")
    .insert({
    userid: null,
    amount: -sellingPrice,
    type: "purchase",
    status: "pending",

    description:
      `${existingOrder.network.toUpperCase()} ${existingOrder.package_size}GB Data Purchase`,

    details: {
      payment_reference: reference,
      bundle_price: sellingPrice,
      base_cost: baseCost,
      recipient: existingOrder.recipient,
    },
  });
  }

// Prevent duplicate fulfillment
const fulfilledStatuses = [
  "processing",
  "completed",
  "delivered",
  "processing_locked",
];

if (fulfilledStatuses.includes(existingOrder.status)) {
  console.log(`Order already fulfilled/processing: ${reference}`);

  await markWebhookProcessed(supabase, reference);

  return;
}

// ── ACQUIRE PROCESSING LOCK ────────────────────────────────────────

const { data: lockedOrder, error: lockError } = await supabase
  .from("adminorders")
  .update({
    processing_lock: true,
    status: "processing_locked",
    updated_at: new Date().toISOString(),
  })
  .eq("payment_reference", reference)
  .eq("processing_lock", false)
  .select()
  .single();

    if (!lockedOrder || lockError) {
  console.log(`Order already locked by another process: ${reference}`);

  await markWebhookProcessed(supabase, reference);

  return;
}

 console.log(`Processing lock acquired: ${reference}`);

// ── Webhook-only fulfillment acknowledged ──────────────────────────
// guest-buy-data already initialized the order.
// This webhook now owns processing safely.

 // ── SAFE WEBHOOK FULFILLMENT ───────────────────────────────────────
const external_order_id = generateExternalOrderId();

console.log(`Placing provider order for ${reference}`);

const orderResult = await placeOrder(supabase, {
  network: existingOrder.network,
  phone: existingOrder.recipient,
  bundleSize: existingOrder.package_size,
  orderId: external_order_id,
});

// Provider acceptance logic
const providerAccepted =
  orderResult.success === true;
if (!providerAccepted) {
  console.error(`Provider fulfillment failed: ${reference}`);

  const providerErrorText = JSON.stringify(
    orderResult?.error || orderResult?.data || {}
  ).toLowerCase();

  const requiresManualReview =
    providerErrorText.includes("insufficient balance") ||
    providerErrorText.includes("manual") ||
    providerErrorText.includes("fallback") ||
    providerErrorText.includes("provider_error");

  const failureStatus = requiresManualReview
    ? "manual_review"
    : "failed_provider";

  await supabase
    .from("adminorders")
    .update({
      status: failureStatus,
      processing_lock: false,
      updated_at: new Date().toISOString(),

      external_response: {
        ...(existingOrder.external_response || {}),

        provider_error:
          orderResult?.error || orderResult?.data,

        manual_fallback: requiresManualReview,

        requires_manual_processing:
          requiresManualReview,

        failed_at: new Date().toISOString(),
      },
    })
    .eq("payment_reference", reference);

  // Keep guest_orders synchronized
  await supabase
    .from("guest_orders")
    .update({
      status: failureStatus,
    })
    .eq("payment_reference", reference);
    await supabase
  .from("transactions")
  .update({
    status: "failed",
    updated_at: new Date().toISOString(),
  })
  .eq(
    "details->>payment_reference",
    reference
  );
  await markWebhookProcessed(supabase, reference);

  return;
}

const profit = parseFloat(
  (sellingPrice - baseCost).toFixed(2)
);

// Successful fulfillment update
await supabase
  .from("adminorders")
  .update({
    status: "processing",
    description:
  `${existingOrder.network.toUpperCase()} ${existingOrder.package_size}GB Data Purchase`,
    processing_lock: false,
    updated_at: new Date().toISOString(),
    external_response: {
      ...(existingOrder.external_response || {}),
      provider: orderResult.provider,
      provider_response: orderResult.data,
      provider_reference:
        orderResult?.data?._dbh_reference ??
        orderResult?.data?.reference ??
        null,
      base_cost: baseCost,
      selling_price: sellingPrice,
      profit,
      fulfilled_at: new Date().toISOString(),
    },
  })
  .eq("payment_reference", reference);

// Update guest_orders too
await supabase
  .from("guest_orders")
  .update({
    status: "processing",
    payment_verified: true,
    payment_verified_at: new Date().toISOString(),
    sparkdata_response: orderResult.data,
  })
  .eq("payment_reference", reference);
  await supabase
  .from("transactions")
  .update({
    status: "processing",
    updated_at: new Date().toISOString(),

    details: {
      payment_reference: reference,
      provider: orderResult.provider,
      provider_response: orderResult.data,
      bundle_price: sellingPrice,
      base_cost: baseCost,
      profit,
      recipient: existingOrder.recipient,
    },
  })
  .eq(
    "details->>payment_reference",
    reference
  );
await markWebhookProcessed(supabase, reference);
console.log(`Webhook fulfillment completed successfully: ${reference}`);
}
async function writeOrphan(
  supabase: any,
  reference: string,
  amount: number,
  paystackData: any,
  reason: string,
) {

  const { error } = await supabase
    .from("webhook_orphans")
    .upsert(
      {
        reference,
        amount,
        reason,
        paystack_data: paystackData,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "reference" }
    );

  if (error) {
    console.error(
      "writeOrphan failed:",
      error
    );
  }
}
async function markWebhookProcessed(supabase: any, reference: string) {
  await supabase
    .from("webhook_events")
    .update({ processed: true, updated_at: new Date().toISOString() })
    .eq("reference", reference);
}