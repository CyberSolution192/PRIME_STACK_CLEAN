/**
 * _shared/dataspark.ts
 *
 * Dataspark Partner API client (https://dataspark.store/api/v1).
 * Imported by every edge function that talks to Dataspark:
 *   buy-data, api-order, guest-buy-data, paystack-webhook  -> placeDatasparkOrder()
 *   reconcile-stale-orders                                  -> getDatasparkOrderByReference()
 *   sync-bundle-costs                                       -> listDatasparkBundles()
 *
 * SECURITY
 *   - The API key lives ONLY in the Supabase secret DATASPARK_API_KEY
 *     (supabase secrets set DATASPARK_API_KEY=...). It is read here, server
 *     side, and is never logged, returned to a caller or stored in the DB.
 *   - Dataspark rejects browser calls on purpose; this module is only ever
 *     imported by edge functions.
 *
 * AUTO-FALLBACK SAFETY (guest-buy-data / paystack-webhook retry a fallback provider when the
 * error text contains "HTTP 5", "HTTP 429" or "network error"):
 *   - Failures where we KNOW nothing was placed (rate limit, provider unreachable, a 5xx
 *     followed by a confirmed "not found" lookup) use that wording, so fallback may proceed.
 *   - AMBIGUOUS outcomes (timeout/5xx and we could not confirm either way) deliberately do
 *     NOT use that wording. Falling back there could deliver the data twice (Dataspark may
 *     have accepted it). Those go to manual review with the reference to verify instead.
 *
 * ROUTING TO MANUAL REVIEW: the order functions decide manual_review vs failed_provider by looking for
 * words like "insufficient balance" / "manual" in the error text. The unconfirmed-outcome and
 * low-wallet messages below include those words on purpose, so a human always checks them.
 *
 * HOW IT DIFFERS FROM THE OTHER PROVIDERS
 *   - Dataspark buys by bundle_id (not network + size), so we first resolve
 *     (network, sizeGb) -> bundle_id from GET /bundles.
 *   - Orders are asynchronous: a new order is always "processing" and later
 *     becomes "completed" or "failed" (webhook and/or reconcile-stale-orders).
 *   - Orders are idempotent on client_reference. We use OUR order id
 *     (TXN-...) as client_reference, so a retry can never charge us twice and
 *     any order can be looked up later from our own reference alone.
 */

const BASE_URL   = "https://dataspark.store/api/v1";
const TIMEOUT_MS = 12_000;
const BUNDLE_CACHE_MS = 60_000;
const NETWORKS   = new Set(["mtn", "telecel", "airteltigo"]);
// Dataspark: client_reference is 1-64 chars of A-Z a-z 0-9 . _ : -
const REFERENCE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export interface DatasparkOrderInput {
  network: string;     // internal key: mtn | telecel | airteltigo
  phone: string;       // 10-digit Ghana number, e.g. 0244123456
  bundleSize: number;  // GB
  orderId: string;     // our order id, used as Dataspark client_reference
}

export interface DatasparkResult {
  success: boolean;
  data?: any;
  error?: string;
}

export interface DatasparkOrder {
  id: string;
  client_reference: string;
  status: "processing" | "completed" | "failed";
  network: string;
  bundle: string;
  phone: string;
  amount: number;
  currency: string;
  refunded: boolean;
  created_at: string;
  completed_at: string | null;
}

// ─── Low-level request (timeout, auth, safe JSON) ────────────────────────────
interface RawResponse {
  ok: boolean;
  status: number;
  body: any;                 // parsed JSON or null
  networkError?: string;     // set when no HTTP response was received at all
  retryAfter?: number;
}

async function dsRequest(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
): Promise<RawResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
        ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      redirect: "error",
      signal: ctrl.signal,
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }
    const ra = parseInt(res.headers.get("Retry-After") || "", 10);
    return { ok: res.ok, status: res.status, body, retryAfter: Number.isFinite(ra) ? ra : undefined };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return { ok: false, status: 0, body: null, networkError: aborted ? "timeout" : "connection error" };
  } finally {
    clearTimeout(timer);
  }
}

function errorText(r: RawResponse): string {
  const code = r.body?.error?.code || `http_${r.status}`;
  const msg  = r.body?.error?.message || "Unknown error";
  const rid  = r.body?.error?.request_id ? ` [request_id ${r.body.error.request_id}]` : "";
  return `${code}: ${msg}${rid}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Bundles ─────────────────────────────────────────────────────────────────
export interface DatasparkBundle {
  id: string;
  network: string;
  name: string;
  size_gb: number | null;
  validity: string;
  price: number;
  currency: string;
}

const bundleCache = new Map<string, { at: number; bundles: DatasparkBundle[] }>();

/** GET /bundles — returns null when the key is missing or the call fails. */
export async function listDatasparkBundles(network?: string, useCache = false): Promise<DatasparkBundle[] | null> {
  const apiKey = Deno.env.get("DATASPARK_API_KEY");
  if (!apiKey) return null;

  const cacheKey = network || "all";
  const hit = bundleCache.get(cacheKey);
  if (useCache && hit && Date.now() - hit.at < BUNDLE_CACHE_MS) return hit.bundles;

  const q = network && NETWORKS.has(network) ? `?network=${network}` : "";
  const r = await dsRequest(apiKey, "GET", `/bundles${q}`);
  if (!r.ok || !Array.isArray(r.body?.data)) {
    console.error(`[Dataspark] bundles fetch failed: ${r.networkError || errorText(r)}`);
    return null;
  }
  bundleCache.set(cacheKey, { at: Date.now(), bundles: r.body.data });
  return r.body.data;
}

/** size_gb can be null (it is parsed from the bundle name), so fall back to the name. */
export function datasparkSizeGb(b: { size_gb?: number | null; name?: string }): number | null {
  if (typeof b.size_gb === "number" && Number.isFinite(b.size_gb)) return b.size_gb;
  const m = String(b.name || "").match(/([\d.]+)\s*GB/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pick the bundle for (network, size). If several share a size (e.g. different
 * validity), prefer a 30-day bundle, otherwise the first (API lists cheapest first).
 */
function pickBundle(bundles: DatasparkBundle[], network: string, size: number): DatasparkBundle | null {
  const matches = bundles.filter(
    (b) => b.network === network && Math.abs((datasparkSizeGb(b) ?? -1) - size) < 0.001,
  );
  if (matches.length === 0) return null;
  return matches.find((b) => /30\s*day/i.test(b.validity || "")) || matches[0];
}

// ─── Look up an order by our reference ───────────────────────────────────────
export interface DatasparkLookup {
  found: boolean;               // true = Dataspark has this order
  order?: DatasparkOrder;
  notFound?: boolean;           // definitive 404: Dataspark never received it
  error?: string;               // transient/unknown problem
}

export async function getDatasparkOrderByReference(reference: string): Promise<DatasparkLookup> {
  const apiKey = Deno.env.get("DATASPARK_API_KEY");
  if (!apiKey) return { found: false, error: "Dataspark API key not configured" };
  if (!REFERENCE_RE.test(reference)) return { found: false, error: "invalid reference format" };

  const r = await dsRequest(apiKey, "GET", `/orders?client_reference=${encodeURIComponent(reference)}`);
  if (r.ok && r.body && r.body.id) return { found: true, order: r.body as DatasparkOrder };
  if (r.status === 404 && r.body?.error?.code === "order_not_found") return { found: false, notFound: true };
  return { found: false, error: r.networkError || errorText(r) };
}

// ─── Place an order ──────────────────────────────────────────────────────────
export async function placeDatasparkOrder(payload: DatasparkOrderInput): Promise<DatasparkResult> {
  const apiKey = Deno.env.get("DATASPARK_API_KEY");
  if (!apiKey) return { success: false, error: "Dataspark API key not configured" };

  if (!NETWORKS.has(payload.network)) {
    return { success: false, error: `Dataspark error: unsupported network "${payload.network}"` };
  }
  if (!REFERENCE_RE.test(payload.orderId)) {
    return { success: false, error: "Dataspark error: order id is not a valid client_reference" };
  }

  try {
    // 1. (network, size) -> bundle_id
    const bundles = await listDatasparkBundles(payload.network, true);
    if (!bundles) return { success: false, error: "Dataspark network error: could not load bundle list (nothing was placed)" };
    const bundle = pickBundle(bundles, payload.network, payload.bundleSize);
    if (!bundle) {
      return { success: false, error: `Dataspark error: no ${payload.network.toUpperCase()} ${payload.bundleSize}GB bundle available at provider` };
    }

    console.log(`[Dataspark] Placing order ${payload.orderId} — ${payload.network} ${payload.bundleSize}GB (${bundle.id}) -> ${payload.phone}`);

    const body = {
      bundle_id: bundle.id,
      phone: payload.phone,
      client_reference: payload.orderId,
      network: payload.network, // Dataspark verifies it matches the bundle
    };

    // 2. Place it. Up to 2 attempts, always with the SAME client_reference, so a
    //    retry after an ambiguous failure can never double-charge.
    let last: RawResponse | null = null;
    let confirmedNotPlaced = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await dsRequest(apiKey, "POST", "/orders", body);
      last = r;

      // Accepted (202) or already placed with same details (200 replay)
      if ((r.status === 202 || r.status === 200) && r.body?.id) {
        const order = r.body as DatasparkOrder;
        if (order.status === "failed") {
          return { success: false, error: `Dataspark error: order ${order.id} failed at provider${order.refunded ? " (refunded to provider wallet)" : ""}` };
        }
        console.log(`[Dataspark] Accepted ${payload.orderId} -> ${order.id} (${order.status})`);
        return {
          success: true,
          data: {
            message: "Order received and queued for processing.",
            status: order.status,
            amount: order.amount,
            _provider: "dataspark",
            _network_key: payload.network,
            _dataspark_order_id: order.id,
            _dataspark_reference: order.client_reference,
            _dataspark_bundle_id: bundle.id,
          },
        };
      }

      // Definite rejection: nothing was placed or charged. Do not retry.
      const definite = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
      if (definite) {
        const code = r.body?.error?.code;
        if (code === "insufficient_balance") {
          return { success: false, error: "Dataspark error: insufficient_balance  provider insufficient balance, manual top-up needed" };
        }
        return { success: false, error: `Dataspark error: ${errorText(r)}` };
      }

      // 429: not placed. One polite retry if the wait is short, else give up.
      if (r.status === 429) {
        if (attempt === 1 && (r.retryAfter ?? 99) <= 3) { await sleep((r.retryAfter ?? 1) * 1000); continue; }
        return { success: false, error: `Dataspark HTTP 429: ${errorText(r)} (nothing was placed)` };
      }

      // Ambiguous: timeout / connection error / 5xx. The order MAY have been placed.
      // Ask Dataspark by our reference before doing anything else.
      await sleep(1500);
      const look = await getDatasparkOrderByReference(payload.orderId);
      if (look.found && look.order) {
        console.log(`[Dataspark] Recovered ${payload.orderId} after ambiguous response -> ${look.order.id}`);
        return {
          success: true,
          data: {
            message: "Order received and queued for processing.",
            status: look.order.status,
            amount: look.order.amount,
            _provider: "dataspark",
            _network_key: payload.network,
            _dataspark_order_id: look.order.id,
            _dataspark_reference: look.order.client_reference,
            _dataspark_bundle_id: bundle.id,
          },
        };
      }
      if (!look.notFound) { confirmedNotPlaced = false; break; } // cannot tell either way — stop, do not guess
      confirmedNotPlaced = true; // Dataspark has no such order -> safe to retry with the same reference
    }

    if (confirmedNotPlaced && last) {
      // Provider is failing, but we CONFIRMED it holds no order for our reference -> fallback-safe.
      return {
        success: false,
        error: last.networkError
          ? `Dataspark network error: ${last.networkError} (order confirmed not placed at provider)`
          : `Dataspark HTTP ${last.status}: ${errorText(last)} (order confirmed not placed at provider)`,
      };
    }

    return {
      success: false,
      error: `Dataspark error: outcome unknown (${last?.networkError || (last ? errorText(last) : "no response")}). ` +
             `Provider may have received it. Manual review required: verify reference ${payload.orderId} in the Dataspark dashboard before refunding.`,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? `Dataspark error: ${err.message}` : "Dataspark unknown error" };
  }
}
