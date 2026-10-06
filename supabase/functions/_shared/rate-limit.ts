/**
 * _shared/rate-limit.ts
 *
 * Generic rate limiter for any bucket key (per-IP, per-user, per-endpoint,
 * or a combination) — extends the same pattern already used correctly for
 * the partner API in api-auth.ts (checkRateLimit against api_keys rows),
 * generalized so it can also protect user-proxy and the public/guest
 * endpoints, which have no existing row to attach a counter to.
 *
 * Upgraded from a pure fixed window to a two-window weighted approximation:
 * a pure fixed window lets someone send `limit` requests right at 0:59 and
 * another `limit` at 1:01 — effectively 2x the limit in 2 seconds. This
 * blends the previous window's count in, weighted by how far into the
 * current window we are, without needing Redis or storing a timestamp per
 * request.
 *
 * Requires a `rate_limit_buckets` table — see the accompanying
 * rate_limit_buckets.sql migration.
 *
 * Usage:
 *   import { checkRateLimit, getClientIp } from "../_shared/rate-limit.ts";
 *
 *   const rate = await checkRateLimit(supabase, `proxy:user:${userId}`, 80, 60_000);
 *   if (!rate.allowed) return json({ success: false, message: "Too many requests", retry_after_seconds: rate.retryAfter }, 429);
 */

export interface RateLimitResult {
  allowed:     boolean;
  retryAfter?: number;
}

export async function checkRateLimit(
  supabase: any,
  bucketKey: string,
  limit: number,
  windowMs = 60_000,
): Promise<RateLimitResult> {
  const now = Date.now();

  const { data: row, error } = await supabase
    .from("rate_limit_buckets")
    .select("window_start, current_count, prev_count")
    .eq("bucket_key", bucketKey)
    .maybeSingle();

  if (error) {
    // Fail open — a rate-limit lookup failure should never take the site
    // down for legitimate users. Same posture as the existing api-auth.ts.
    console.warn("[rate-limit] lookup failed — failing open:", error.message);
    return { allowed: true };
  }

  let windowStart   = row?.window_start ? new Date(row.window_start).getTime() : now;
  let currentCount  = row?.current_count ?? 0;
  let prevCount     = row?.prev_count ?? 0;
  const elapsed     = now - windowStart;

  if (elapsed >= windowMs * 2) {
    // Long idle gap — nothing meaningful to carry over.
    windowStart  = now;
    currentCount = 0;
    prevCount    = 0;
  } else if (elapsed >= windowMs) {
    // Rolled into a new window — last window's count becomes "prev".
    windowStart  = windowStart + windowMs;
    prevCount    = currentCount;
    currentCount = 0;
  }

  const elapsedInCurrent = now - windowStart;
  const prevWeight       = Math.max(0, (windowMs - elapsedInCurrent) / windowMs);
  const weightedCount    = currentCount + prevCount * prevWeight;

  if (weightedCount >= limit) {
    const retryAfter = Math.ceil((windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }

  // Increment — fire and forget, non-blocking (same pattern as api-auth.ts).
  supabase
    .from("rate_limit_buckets")
    .upsert({
      bucket_key:    bucketKey,
      window_start:  new Date(windowStart).toISOString(),
      current_count: currentCount + 1,
      prev_count:    prevCount,
      updated_at:    new Date().toISOString(),
    }, { onConflict: "bucket_key" })
    .then(({ error: upErr }: { error: any }) => {
      if (upErr) console.warn("[rate-limit] counter update failed:", upErr.message);
    });

  return { allowed: true };
}

/**
 * Best-effort client IP extraction. Supabase Edge Functions sit behind a
 * proxy, so req.headers doesn't contain a raw socket IP — this reads the
 * headers a proxy/CDN sets. If you enable Cloudflare in front of the site
 * (recommended — see the DDoS discussion), cf-connecting-ip is the most
 * reliable of these; x-forwarded-for is the fallback.
 */
export function getClientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}
