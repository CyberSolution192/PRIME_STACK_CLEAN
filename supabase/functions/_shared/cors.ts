/**
 * cors.ts — shared CORS origin allowlist
 *
 * Fixes a copy-paste bug found in unlock-store and save-store-settings,
 * where Access-Control-Allow-Origin was set to the Supabase project URL
 * (https://<ref>.supabase.co) instead of the actual frontend domain —
 * meaning the browser's CORS check for those two endpoints would never
 * actually match a request coming from the real site.
 *
 * This mirrors the getAllowedOrigin() pattern already used correctly in
 * user-auth, verify-paystack, user-proxy, admin-auth, and others —
 * centralized here so it can't drift out of sync between functions again.
 */

const IS_PRODUCTION = Deno.env.get("ENVIRONMENT") === "production";

const ALLOWED_ORIGINS = new Set([
  "https://primeconnect.site",
  // Local dev origins — automatically excluded in production
  ...(IS_PRODUCTION ? [] : [
    "http://127.0.0.1:5500",
    "http://127.0.0.1:5501",
    "http://127.0.0.1:5503",
    "http://localhost:5500",
    "http://localhost:5501",
    "http://localhost:5503",
    "http://localhost:3000",
  ]),
]);

/** Returns the request's Origin if it's on the allowlist, otherwise a
 *  value that will never match any real origin (so the browser blocks it). */
export const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost):\d+$/;

function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('Origin') ?? '';
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (!IS_PRODUCTION && LOCAL_DEV_ORIGIN_RE.test(origin)) return origin;
  return 'https://no-cors-for-you';
}

/** Standard CORS header set for a given request, ready to spread into a
 *  Response's headers object. */
export function corsHeaders(req: Request, extraHeaders = "authorization, x-client-info, apikey, content-type") {
  return {
    "Access-Control-Allow-Origin": getAllowedOrigin(req),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": extraHeaders,
  };
}