import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ─── Types ────────────────────────────────────────────────────────────────────
type Provider = 'justicedata' | 'pensite' | 'hubnet' | 'sparkdata' | 'databosshub';

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

// ─── Validation ───────────────────────────────────────────────────────────────
function validatePhoneNumber(phone: string): boolean {
  return /^[0-9]{10}$/.test(phone);
}

function generateOrderId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `TXN-${timestamp}-${random}`.toUpperCase();
}

// ─── Network Mappers ──────────────────────────────────────────────────────────

function mapNetworkJusticeData(network: string, size: number): string {
  if (network === 'mtn') return 'MTN';
  if (network === 'telecel') return 'TELECEL';
  if (network === 'airteltigo') return size >= 15 ? 'AIRTELTIGO_BIGTIME' : 'AIRTELTIGO_ISHARE';
  return network.toUpperCase();
}

function mapNetworkPensite(network: string, size: number): string {
  if (network === 'mtn') return 'YELLO';
  if (network === 'telecel') return 'TELECEL';
  if (network === 'airteltigo') return size >= 15 ? 'AT_BIGTIME' : 'AT_PREMIUM';
  return network.toUpperCase();
}

function mapNetworkHubnet(network: string, size: number): string {
  if (network === 'mtn') return 'mtn';
  if (network === 'telecel') return 'telecel';
  if (network === 'airteltigo') return size >= 15 ? 'big-time' : 'at';
  return network;
}

function mapNetworkSparkData(network: string, size: number): string {
  if (network === 'mtn') return 'mtn';
  if (network === 'telecel') return 'telecel';
  if (network === 'airteltigo') return size >= 15 ? 'bigtime' : 'ishare';
  return network.toLowerCase();
}

/**
 * DataBossHub network keys (exact casing required by their API):
 *   mtn        -> "MTN"
 *   telecel    -> "Telecel"
 *   airteltigo -> "Airteltigo"  lowercase 't' — must match exactly
 *
 * Option B chosen: plain "MTN" only — Express(MTN) intentionally excluded.
 * DataBossHub is treated as a standard 5th switchable provider.
 */
function mapNetworkDataBossHub(network: string): string {
  if (network === 'mtn')        return 'MTN';
  if (network === 'telecel')    return 'Telecel';
  if (network === 'airteltigo') return 'Airteltigo';
  return network;
}

// ─── Provider: Justice Data Shop ─────────────────────────────────────────────
async function placeJusticeDataOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("JUSTICEDATA_API_KEY");
  if (!apiKey) return { success: false, error: "Justice Data Shop API key not configured" };

  const networkKey = mapNetworkJusticeData(payload.network, payload.bundleSize);
  try {
    console.log(`[JusticeData] Placing order ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB -> ${payload.phone}`);
    const response = await fetch("https://backend.justicedatashop.com/api/order", {
      method: 'POST',
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: payload.phone, size: payload.bundleSize, network: networkKey })
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `JusticeData HTTP ${response.status}: ${errorText}` };
    }
    const data = await response.json();
    if (!data.status) return { success: false, error: `JusticeData error: ${data.message || 'Unknown error'}` };
    console.log(`[JusticeData] Success:`, JSON.stringify(data));
    return { success: true, data: { ...data, _provider: 'justicedata', _network_key: networkKey } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'JusticeData unknown error' };
  }
}

// ─── Provider: Pensite ────────────────────────────────────────────────────────
async function placePensiteOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("PENSITE_API_KEY");
  if (!apiKey) return { success: false, error: "Pensite API key not configured" };

  const networkKey = mapNetworkPensite(payload.network, payload.bundleSize);
  try {
    console.log(`[Pensite] Placing order ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB -> ${payload.phone}`);
    const response = await fetch("https://pensitegh.com/api/purchase", {
      method: 'POST',
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ networkKey, recipient: payload.phone, capacity: payload.bundleSize })
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Pensite HTTP ${response.status}: ${errorText}` };
    }
    const data = await response.json();
    if (data.status !== 'success') return { success: false, error: `Pensite error: ${data.message || 'Unknown error'}` };
    console.log(`[Pensite] Success:`, JSON.stringify(data));
    return { success: true, data: { ...data, _provider: 'pensite', _network_key: networkKey } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Pensite unknown error' };
  }
}

// ─── Provider: Hubnet ─────────────────────────────────────────────────────────
async function placeHubnetOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("HUBNET_API_KEY");
  if (!apiKey) return { success: false, error: "Hubnet API key not configured" };

  const networkKey = mapNetworkHubnet(payload.network, payload.bundleSize);
  const volumeMB = String(payload.bundleSize * 1000);
  const hubnetRef = payload.orderId.substring(0, 25);

  try {
    console.log(`[Hubnet] Placing order ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB -> ${payload.phone}`);
    const response = await fetch(
      `https://console.hubnet.app/live/api/context/business/transaction/${networkKey}-new-transaction`,
      {
        method: 'POST',
        headers: { "token": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ phone: payload.phone, volume: volumeMB, reference: hubnetRef })
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Hubnet HTTP ${response.status}: ${errorText}` };
    }
    const data = await response.json();
    if (!data.status || data.message !== '0000') {
      return { success: false, error: `Hubnet error: ${data.reason || data.code || 'Unknown error'}` };
    }
    console.log(`[Hubnet] Success:`, JSON.stringify(data));
    return { success: true, data: { ...data, _provider: 'hubnet', _network_key: networkKey } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Hubnet unknown error' };
  }
}

// ─── Provider: Spark Data GH ──────────────────────────────────────────────────
async function placeSparkDataOrder(payload: OrderPayload): Promise<ProviderResult> {
  const username    = Deno.env.get("SPARKDATA_USERNAME");
  const appPassword = Deno.env.get("SPARKDATA_APP_PASSWORD");
  if (!username || !appPassword) return { success: false, error: "Spark Data GH credentials not configured" };

  const credentials = btoa(`${username}:${appPassword}`);
  const networkKey  = mapNetworkSparkData(payload.network, payload.bundleSize);

  try {
    console.log(`[SparkData] Placing order ${payload.orderId} — ${payload.network} (${networkKey}) ${payload.bundleSize}GB -> ${payload.phone}`);
    const response = await fetch("https://sparkdatagh.com/wp-json/custom/v1/place-order", {
      method: 'POST',
      headers: { "Authorization": `Basic ${credentials}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network:      networkKey,
        recipient:    payload.phone,
        package_size: payload.bundleSize,
        order_id:     payload.orderId,
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `SparkData HTTP ${response.status}: ${errorText}` };
    }
    const data = await response.json();
    if (data.status !== 'success') return { success: false, error: `SparkData error: ${data.message || 'Unknown error'}` };
    console.log(`[SparkData] Success:`, JSON.stringify(data));
    return { success: true, data: { ...data, _provider: 'sparkdata', _network_key: networkKey } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'SparkData unknown error' };
  }
}

// ─── Provider: DataBossHub ────────────────────────────────────────────────────
async function placeDataBossHubOrder(payload: OrderPayload): Promise<ProviderResult> {
  const apiKey = Deno.env.get("DATABOSSHUB_API_KEY");
  if (!apiKey) return { success: false, error: "DataBossHub API key not configured" };

  const networkKey = mapNetworkDataBossHub(payload.network);
  // DataBossHub accepts data_plan as a string label e.g. "1GB", "2GB".
  // Built from bundleSize integer. Verify exact labels from GET /bundles before go-live.
  const dataPlan = `${payload.bundleSize}GB`;

  try {
    console.log(`[DataBossHub] Placing order ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB (${networkKey}/${dataPlan}) -> ${payload.phone}`);

    const response = await fetch("https://bbhubportal.com/api/v1/order", {
      method: 'POST',
      headers: {
        "X-API-KEY":    apiKey,
        "Content-Type": "application/json",
        "Accept":       "application/json",
      },
      body: JSON.stringify({
        network:     networkKey,     // "MTN" | "Telecel" | "Airteltigo"
        data_plan:   dataPlan,       // "1GB" | "2GB" etc.
        beneficiary: payload.phone,  // 10-digit Ghana number e.g. "0241234567"
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // 403 NETWORK_UNAVAILABLE -> balance NOT debited on their end
      if (response.status === 403) {
        let parsed: any = {};
        try { parsed = JSON.parse(errorText); } catch { /* ignore */ }
        if (parsed.code === 'NETWORK_UNAVAILABLE') {
          return { success: false, error: `DataBossHub: ${networkKey} is currently unavailable on their portal` };
        }
      }
      return { success: false, error: `DataBossHub HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    // DataBossHub success envelope: { status: "success", data: { reference, ... }, meta: {...} }
    if (data.status !== 'success') {
      return { success: false, error: `DataBossHub error: ${data.message || 'Unknown error'}` };
    }

    console.log(`[DataBossHub] Success:`, JSON.stringify(data));
    return {
      success: true,
      data: {
        ...data.data,
        message:        data.data?.message || 'Order placed successfully',
        _provider:      'databosshub',
        _network_key:   networkKey,
        _dbh_reference: data.data?.reference, // their own ref — useful for GET /order-status
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'DataBossHub unknown error' };
  }
}

// ─── Active Provider Dispatcher ───────────────────────────────────────────────
async function placeOrder(
  supabase: any,
  payload: OrderPayload
): Promise<ProviderResult & { provider: Provider }> {

  const { data: setting } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'active_provider')
    .single();

  const provider: Provider = (setting?.value as Provider) || 'justicedata';
  console.log(`Active provider: ${provider}`);

  let result: ProviderResult;

  switch (provider) {
    case 'pensite':
      result = await placePensiteOrder(payload);
      break;
    case 'hubnet':
      result = await placeHubnetOrder(payload);
      break;
    case 'sparkdata':
      result = await placeSparkDataOrder(payload);
      break;
    case 'databosshub':
      result = await placeDataBossHubOrder(payload);
      break;
    case 'justicedata':
    default:
      result = await placeJusticeDataOrder(payload);
      break;
  }

  return { ...result, provider };
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ status: false, message: 'Method Not Allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
   let order_id: string | undefined;
   let supabase: any;
  try {
    // SECURITY: Verify JWT and extract authenticated user identity
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return new Response(
        JSON.stringify({ status: false, message: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const anonClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!
    );
    const { data: { user: authedUser }, error: authError } = await anonClient.auth.getUser(token);
    if (authError || !authedUser) {
      return new Response(
        JSON.stringify({ status: false, message: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { network, phone, size } = await req.json();

    // SECURITY: user_id from verified JWT only — never from request body
    const user_id = authedUser.id;
    console.log('buy-data request:', { network, phone, size, user_id });

    if (!network || !phone || !size) {
      return new Response(
        JSON.stringify({ status: false, message: "Missing required parameters" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const validNetworks = ['mtn', 'telecel', 'airteltigo'];
    if (!validNetworks.includes(network.toLowerCase())) {
      return new Response(
        JSON.stringify({ status: false, message: "Invalid network" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!validatePhoneNumber(phone)) {
      return new Response(
        JSON.stringify({ status: false, message: "Invalid phone number format. Must be 10 digits." }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const bundleSize = parseInt(size);
    if (isNaN(bundleSize) || bundleSize <= 0) {
      return new Response(
        JSON.stringify({ status: false, message: "Invalid bundle size" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

        supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

    const { data: bundleData, error: bundleError } = await supabase
      .from('bundles')
      .select('id, price')
      .eq('network', network.toLowerCase())
      .eq('size', bundleSize)
      .eq('active', true)
      .single();

    if (bundleError || !bundleData) {
      return new Response(
        JSON.stringify({ status: false, message: "Bundle not available for this network/size" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const basePrice = parseFloat(bundleData.price);

    // SECURITY: Price always from DB, never from client.
    // Pricing priority:
    //   1. user_bundle_prices — admin-set custom cost per user
    //   2. bundles.price      — admin base price fallback
    let finalPrice  = basePrice;
    let priceSource = 'base';

    const { data: userCustomPrice } = await supabase
      .from('user_bundle_prices')
      .select('custom_price')
      .eq('user_id', user_id)
      .eq('bundle_id', bundleData.id)
      .maybeSingle();

    if (userCustomPrice?.custom_price) {
      const parsed = parseFloat(userCustomPrice.custom_price);
      if (!isNaN(parsed) && parsed > 0) {
        finalPrice  = parsed;
        priceSource = 'admin_custom';
        console.log(`Admin custom price applied: GH${finalPrice} (base was GH${basePrice})`);
      } else {
        console.warn(`Invalid custom_price (${userCustomPrice.custom_price}) for user ${user_id} — using base price`);
      }
    }

    console.log(`Price: GH${finalPrice} (source: ${priceSource})`);

    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id, balance, version, is_frozen')
      .eq('user_id', user_id)
      .single();

    if (walletError || !wallet) {
      return new Response(
        JSON.stringify({ status: false, message: "Wallet not found" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (wallet.is_frozen) {
      return new Response(
        JSON.stringify({ status: false, message: "Your wallet is frozen. Please contact support." }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const currentBalance = parseFloat(wallet.balance);
    if (currentBalance < finalPrice) {
      return new Response(
        JSON.stringify({
          status: false,
          message: `Insufficient balance. Required: GH${finalPrice.toFixed(2)}, Available: GH${currentBalance.toFixed(2)}`
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

  order_id = generateOrderId();
  const description =
  `${network.toUpperCase()} ${bundleSize}GB Data Purchase`;

await supabase
  .from('transactions')
  .upsert({
    userid: user_id,

    amount: -finalPrice,

    type: 'purchase',

    status: 'pending',

    description,

    details: {
      network: network.toLowerCase(),
      phone_number: phone,
      bundle_size: bundleSize,
      bundle_price: finalPrice,
      base_price: basePrice,
      price_source: priceSource,
      order_id,
      pre_registered: true,
    },

    idempotency_key: order_id,
  }, {
    onConflict: 'idempotency_key',
  });
  await supabase
  .from('adminorders')
  .upsert({
    userid: user_id,

    order_reference: order_id,

    payment_reference: null,

    network: network.toLowerCase(),

    sparkdata_network: network.toLowerCase(),

    recipient: phone,

    package_size: bundleSize,

    amount: finalPrice,

    status: 'pending',

    description,

    external_response: {
      pre_registered: true,
      base_cost: basePrice,
      selling_price: finalPrice,
      price_source: priceSource,
    },
  }, {
    onConflict: 'order_reference',
  });
    // Deduct wallet with optimistic lock (version)
    const newBalance = parseFloat((currentBalance - finalPrice).toFixed(2));
    const { error: walletUpdateError } = await supabase
      .from('wallets')
      .update({ balance: newBalance, version: wallet.version + 1, updated_at: new Date().toISOString() })
      .eq('id', wallet.id)
      .eq('version', wallet.version)
      .select('id');

    if (walletUpdateError) {
      console.error('Wallet update error:', walletUpdateError);
      return new Response(
        JSON.stringify({ status: false, message: "Wallet update failed. Please try again." }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Place order via active provider
    const orderResult = await placeOrder(supabase, {
      network: network.toLowerCase(),
      phone,
      bundleSize,
      orderId: order_id
    });

   const apiSuccess     = orderResult.success;
const activeProvider = orderResult.provider;

const providerErrorText = String(
  orderResult.error || ''
).toLowerCase();

const requiresManualReview =
  !apiSuccess &&
  (
    providerErrorText.includes('insufficient balance') ||
    providerErrorText.includes('manual') ||
    providerErrorText.includes('fallback') ||
    providerErrorText.includes('provider')
  );

const orderStatus = apiSuccess
  ? 'processing'
  : requiresManualReview
    ? 'manual_review'
    : 'failed_provider';
if (!apiSuccess) {
  console.log(
    `[${activeProvider}] failed — flagged for manual processing. Error: ${orderResult.error}`
  );
}

    await supabase.from('transactions').update({
      userid: user_id,
      amount: -finalPrice,
      type: 'purchase',
      status: orderStatus,
      description,
      details: {
        network: network.toLowerCase(),
        phone_number: phone,
        bundle_size: bundleSize,
        bundle_price: finalPrice,
        base_price: basePrice,
        price_source: priceSource,
        order_id,
        provider: activeProvider,
        balance_before: currentBalance,
        balance_after: newBalance,
        manual_fallback: !apiSuccess,
        provider_response: apiSuccess ? orderResult.data : undefined,
        provider_error: !apiSuccess ? orderResult.error : undefined,
           }
    })
    .eq('idempotency_key', order_id);

    await supabase.from('adminorders').update({
      userid: user_id,
      order_reference: order_id,
      payment_reference: null,
      network: network.toLowerCase(),
      sparkdata_network: orderResult.data?._network_key || network,
      recipient: phone,
      package_size: bundleSize,
      amount: finalPrice,
      status: orderStatus,
      description,
      external_response: {
        provider: activeProvider,
        manual_fallback: !apiSuccess,
        provider_response: apiSuccess ? orderResult.data : undefined,
        provider_error: !apiSuccess ? orderResult.error : undefined,
        base_cost:     basePrice,
        selling_price: finalPrice,
        profit:        parseFloat((finalPrice - basePrice).toFixed(2)),
        price_source:  priceSource,
        flagged_at:    !apiSuccess ? new Date().toISOString() : undefined
           }
    })
    .eq('order_reference', order_id);

    return new Response(
      JSON.stringify({
        status: true,
        message: apiSuccess
          ? orderResult.data?.message || orderResult.data?.payload?.status || "Order placed successfully!"
          : "Order received and queued for manual processing. You will receive your data shortly.",
        order_reference: order_id,
        network,
        package_size: bundleSize,
        amount_deducted: finalPrice,
        new_balance: newBalance,
        provider: activeProvider,
        manual_processing: !apiSuccess,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('buy-data unhandled error:', error);
    if (typeof order_id !== 'undefined') {

  await supabase
    .from('transactions')
    .update({
      status: 'manual_review',
    })
    .eq('idempotency_key', order_id);

  await supabase
    .from('adminorders')
    .update({
      status: 'manual_review',
    })
    .eq('order_reference', order_id);
}
    return new Response(
      JSON.stringify({ status: false, message: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});