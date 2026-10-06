// ============================================================
// supabase/functions/user-proxy/index.ts — v3
// ============================================================
// KEY CHANGES from v2.1:
// - Uses Deno.serve() (not serve() from deno std)
// - No method guard — Supabase Edge Function runtime on HTTP/2
//   can misreport req.method; we validate by body content instead
// - x-session-id removed from CORS allow-headers (was in v2)
// - __sid in body replaces x-session-id header for local dev
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTIONS_BASE    = `${SUPABASE_URL}/functions/v1`;
const SESSION_COOKIE    = 'user_sid';
const SESSION_TTL_SEC   = 8 * 60 * 60;

// General ceiling for any single logged-in user across all actions behind
// this gateway (dashboard polling, balance checks, browsing bundles, etc).
const PROXY_RATE_LIMIT = 80;   // requests per minute per user
// Tighter ceiling specifically for buy-data, since each call moves money
// and hits the DataBossHub partner API — a burst here is the costliest
// kind of abuse (see the CSRF/DoS review discussion).
const BUY_DATA_RATE_LIMIT = 12; // requests per minute per user

const ALLOWED_TARGETS = new Set([
  'get-user-data',
  'update-profile',
  'save-store-prices',
  'save-store-settings',
  'submit-withdrawal',
  'unlock-store',
  'buy-data',
  'verify-paystack',
  'set-transaction-pin',
  'api-generate-key',   // ← API key management for resellers
  'get-checker-catalog',  // ← Results Checker feature
  'buy-checker',
  'checker-order-status',
]);

 const IS_PRODUCTION = Deno.env.get('ENVIRONMENT') === 'production';

const ALLOWED_ORIGINS = new Set([
  'https://primeconnect.site',
  ...( IS_PRODUCTION ? [] : [
    'http://127.0.0.1:5500',
    'http://127.0.0.1:5501',
    'http://127.0.0.1:5503',
    'http://localhost:5500',
    'http://localhost:5501',
    'http://localhost:5503',
    "http://localhost:3000", 
  ]),
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Methods':     'POST, OPTIONS',
  'Access-Control-Allow-Headers':     'Content-Type, apikey',
  'Access-Control-Allow-Credentials': 'true',
  'Vary': 'Origin',
};

const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost):\d+$/;

function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('Origin') ?? '';
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (!IS_PRODUCTION && LOCAL_DEV_ORIGIN_RE.test(origin)) return origin;
  return 'https://no-cors-for-you';
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k.trim() === name) return rest.join('=').trim();
  }
  return null;
}

function respond(body: unknown, status: number, req: Request, extra: Record<string,string> = {}): Response {
  const origin = getAllowedOrigin(req);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function validateSession(
  cookieHeader: string,
  sidFromBody: string | null,
): Promise<{ access_token: string; user_id: string; user_email: string } | null> {
  const sessionId = parseCookie(cookieHeader, SESSION_COOKIE) || sidFromBody || null;
  if (!sessionId) return null;

  const db = serviceClient();
  const { data: session, error } = await db
    .from('user_sessions')
    .select('access_token, refresh_token, expires_at, user_id, user_email')
    .eq('session_id', sessionId)
    .single();

  if (error || !session) return null;

  if (new Date(session.expires_at) < new Date()) {
    await db.from('user_sessions').delete().eq('session_id', sessionId);
    return null;
  }

  let accessToken = session.access_token;
  try {
    const payload      = JSON.parse(atob(accessToken.split('.')[1]));
    const needsRefresh = payload.exp - Math.floor(Date.now() / 1000) < 300;
    if (needsRefresh) {
      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data: refreshData } = await anonClient.auth.refreshSession({
        refresh_token: session.refresh_token,
      });
      if (refreshData?.session) {
        const newExpiry = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
        await db.from('user_sessions').update({
          access_token:  refreshData.session.access_token,
          refresh_token: refreshData.session.refresh_token,
          expires_at:    newExpiry,
          last_active:   new Date().toISOString(),
        }).eq('session_id', sessionId);
        accessToken = refreshData.session.access_token;
      }
    } else {
      db.from('user_sessions')
        .update({ last_active: new Date().toISOString() })
        .eq('session_id', sessionId)
        .then(() => {});
    }
  } catch { /* proceed with existing token */ }

  return { access_token: accessToken, user_id: session.user_id, user_email: session.user_email };
}

Deno.serve(async (req: Request) => {
  const origin = getAllowedOrigin(req);

  // ── CORS preflight ─────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': origin, ...CORS_HEADERS },
    });
  }

  // ── CSRF fix #1: actually enforce the origin check ──────────────────────────
  // getAllowedOrigin() was previously only used to LABEL the response's CORS
  // header — it never stopped processing when the origin didn't match, which
  // meant a cross-site request (carrying the SameSite=None session cookie)
  // would still execute even though the attacker's JS couldn't read the reply.
  // Reject outright here instead. The browser's Origin header can't be forged
  // or overridden by client-side JS, even cross-site, so this is a hard
  // guarantee for a browser-only frontend like this one.
  if (origin === 'https://no-cors-for-you') {
    return respond({ error: 'Origin not allowed' }, 403, req);
  }

  // ── CSRF fix #2: require the real Content-Type, don't just parse anything ──
  // req.json() previously parsed the body regardless of what Content-Type was
  // declared. That let a cross-site request labeled Content-Type: text/plain
  // (a "simple request" the browser never preflights) carry a JSON-shaped body
  // straight through. Requiring the real header forces any cross-site attempt
  // back through a CORS preflight, where the origin check above gets to run
  // before anything executes.
  const contentType = req.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return respond({ error: 'Content-Type must be application/json' }, 415, req);
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  // No method guard — Supabase HTTP/2 runtime can misreport req.method.
  // We validate the request entirely by body content.
  let fullBody: Record<string, unknown>;
  try {
    fullBody = await req.json();
  } catch {
    return respond({ error: 'Invalid or missing JSON body' }, 400, req);
  }

  const targetFn    = ((fullBody.__target as string | undefined) ?? '').trim();
  const targetQuery = ((fullBody.__query  as string | undefined) ?? '').trim();
  const sidFromBody = (fullBody.__sid     as string | undefined) ?? null;
  const { __target: _t, __query: _q, __sid: _s, ...requestBody } = fullBody;

  if (!targetFn) {
    return respond({ error: 'Missing __target in request body' }, 400, req);
  }
  if (!ALLOWED_TARGETS.has(targetFn)) {
    return respond({ error: `Unknown target: ${targetFn}` }, 400, req);
  }

  // ── Validate session ───────────────────────────────────────────────────────
  const cookieHeader = req.headers.get('Cookie') ?? '';
  const sessionData  = await validateSession(cookieHeader, sidFromBody);

  if (!sessionData) {
    return respond(
      { success: false, error: 'Session invalid or expired', requiresLogin: true },
      401, req,
    );
  }

  // ── Rate limiting ────────────────────────────────────────────────────────
  // General ceiling covers every action behind this gateway; buy-data gets
  // an additional, tighter ceiling on top since it's the costliest action
  // (moves wallet balance, hits the DataBossHub partner API per call).
  const rlClient = serviceClient();

  const generalRate = await checkRateLimit(rlClient, `proxy:user:${sessionData.user_id}`, PROXY_RATE_LIMIT);
  if (!generalRate.allowed) {
    return respond(
      { success: false, error: 'Too many requests. Please slow down.', retry_after_seconds: generalRate.retryAfter },
      429, req,
    );
  }

  if (targetFn === 'buy-data') {
    const buyRate = await checkRateLimit(rlClient, `buy-data:user:${sessionData.user_id}`, BUY_DATA_RATE_LIMIT);
    if (!buyRate.allowed) {
      return respond(
        { success: false, error: 'Too many purchase attempts. Please wait a moment.', retry_after_seconds: buyRate.retryAfter },
        429, req,
      );
    }
  }

  // ── Forward to target function ─────────────────────────────────────────────
  const targetUrl = targetQuery
    ? `${FUNCTIONS_BASE}/${targetFn}?${targetQuery}`
    : `${FUNCTIONS_BASE}/${targetFn}`;

  let targetRes: Response;
  try {
    targetRes = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionData.access_token}`,
        'apikey':        SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.error(`[user-proxy] Failed to reach ${targetFn}:`, err);
    return respond({ error: `Failed to reach ${targetFn}` }, 502, req);
  }

  // ── Return with CORS headers ───────────────────────────────────────────────
  const responseBody = await targetRes.text();
  return new Response(responseBody, {
    status: targetRes.status,
    headers: {
      'Content-Type':                     targetRes.headers.get('Content-Type') ?? 'application/json',
      'Access-Control-Allow-Origin':      origin,
      'Access-Control-Allow-Credentials': 'true',
      'Vary':                             'Origin',
    },
  });
});