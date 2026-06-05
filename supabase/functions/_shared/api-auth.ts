/**
 * _shared/api-auth.ts
 *
 * Shared helpers imported by every public API edge function:
 *   api-balance, api-order, api-order-status
 *
 * Usage:
 *   import { validateApiKey, checkRateLimit } from "../_shared/api-auth.ts";
 *
 *   const auth = await validateApiKey(req, supabase);
 *   if (!auth.valid) return json({ status: false, statusCode: auth.status, message: auth.message }, auth.status);
 *
 *   const rate = await checkRateLimit(supabase, auth.keyId, 30);
 *   if (!rate.allowed) return json({ status: false, statusCode: 429, message: `Rate limit exceeded. Retry after ${rate.retryAfter} seconds.`, retry_after_seconds: rate.retryAfter }, 429);
 *
 *   // auth.userId is now available for wallet lookups
 */

// ── SHA-256 ────────────────────────────────────────────────────────────────────
async function sha256(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── validateApiKey ─────────────────────────────────────────────────────────────
// Extracts X-API-Key header, hashes it, looks it up in api_keys.
// Returns the user_id and key_id on success so callers can do wallet lookups
// and rate limit checks without a second DB round-trip.
export interface AuthResult {
  valid:   boolean;
  status:  number;
  message: string;
  userId:  string;
  keyId:   string;
}

export async function validateApiKey(
  req: Request,
  supabase: any
): Promise<AuthResult> {
  const apiKey = req.headers.get("X-API-Key")?.trim();

  if (!apiKey) {
    return { valid: false, status: 401, message: "Missing X-API-Key header", userId: "", keyId: "" };
  }

  const keyHash = await sha256(apiKey);

  const { data: keyRow, error } = await supabase
    .from("api_keys")
    .select("id, user_id, is_active")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (error || !keyRow) {
    return { valid: false, status: 401, message: "Invalid API key", userId: "", keyId: "" };
  }

  if (!keyRow.is_active) {
    return { valid: false, status: 403, message: "API key has been revoked. Generate a new key from your dashboard.", userId: "", keyId: "" };
  }

  return { valid: true, status: 200, message: "OK", userId: keyRow.user_id, keyId: keyRow.id };
}

// ── checkRateLimit ─────────────────────────────────────────────────────────────
// Rolling window rate limiter stored in api_keys.request_count + window_start.
// No Redis or external service needed.
//
// limit: max requests allowed per 60-second window
//
// Returns { allowed: true } or { allowed: false, retryAfter: seconds }
const WINDOW_MS = 60_000; // 1 minute

export interface RateLimitResult {
  allowed:     boolean;
  retryAfter?: number;
}

export async function checkRateLimit(
  supabase: any,
  keyId: string,
  limit: number
): Promise<RateLimitResult> {
  const { data: key, error } = await supabase
    .from("api_keys")
    .select("request_count, window_start")
    .eq("id", keyId)
    .single();

  if (error || !key) {
    // Fail open — don't block legitimate traffic due to a lookup error
    console.warn("[api-auth] Rate limit check failed — failing open:", error?.message);
    return { allowed: true };
  }

  const now       = Date.now();
  const winStart  = key.window_start ? new Date(key.window_start).getTime() : 0;
  const inWindow  = (now - winStart) < WINDOW_MS;
  const count     = inWindow ? (key.request_count ?? 0) : 0;

  if (count >= limit) {
    const retryAfter = Math.ceil((winStart + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }

  // Increment counter — fire and forget, non-blocking
  supabase
    .from("api_keys")
    .update({
      request_count: count + 1,
      window_start:  inWindow ? key.window_start : new Date().toISOString(),
      last_used_at:  new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    })
    .eq("id", keyId)
    .then(({ error: updateErr }: { error: any }) => {
      if (updateErr) console.warn("[api-auth] Rate limit counter update failed:", updateErr.message);
    });

  return { allowed: true };
}