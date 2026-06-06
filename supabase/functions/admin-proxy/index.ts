// ============================================================
// supabase/functions/admin-proxy/index.ts  — Enterprise v2
// ============================================================
// CHANGE FROM v1: Session validation is now done DIRECTLY via
// the DB (service role key) instead of an internal HTTP call
// to admin-auth/verify. The internal call went back through
// Supabase's gateway which applies JWT verification to
// server-to-server requests, causing 405 errors even after
// --no-verify-jwt was set on the proxy itself.
//
// x-target-function header routing is KEPT (not moved to body)
// because script.js makes a direct fetch() with this header
// and changing it would require updating a non-module script.
//
// SUPPORTED TARGET FUNCTIONS:
//   admin-manage-orders, admin-manage-users,
//   admin-manage-bundles, admin-manage-withdrawals,
//   set-announcement, send-sms
//
// Deploy: supabase functions deploy admin-proxy --no-verify-jwt
// ============================================================

import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { logSecurityEvent, getClientIp } from '../_shared/security-logger.ts';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTIONS_BASE    = `${SUPABASE_URL}/functions/v1`;
const SESSION_COOKIE    = 'admin_sid';   // admin uses a different cookie name
const SESSION_TTL_SEC   = 8 * 60 * 60;

const ALLOWED_TARGETS = new Set([
  'admin-manage-orders',
  'admin-manage-users',
  'admin-manage-bundles',
  'admin-manage-withdrawals',
  'admin-manage-stores',
  'set-announcement',
  'send-sms',
  'admin-manage-api-keys',  // ← API key management for operator oversight
  'admin-security-logs',    // ← Security logs viewer
]);

const IS_PRODUCTION = Deno.env.get('ENVIRONMENT') === 'production';

const ALLOWED_ORIGINS = new Set([
  "https://primeconnect.site",
  "https://primestacktec.netlify.app",
  ...( IS_PRODUCTION ? [] : [
    'http://127.0.0.1:5500',
    'http://127.0.0.1:5501',
    'http://localhost:5500',
    'http://localhost:5501',
    "http://localhost:3000", 
  ]),
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('Origin') ?? '';
  return ALLOWED_ORIGINS.has(origin) ? origin : 'https://no-cors-for-you';
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k.trim() === name) return rest.join('=').trim();
  }
  return null;
}

function json(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
  req?: Request,
): Response {
  const origin = req ? getAllowedOrigin(req) : 'https://no-cors-for-you';
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      // Keep x-target-function in allowed headers — script.js sends it directly
      'Access-Control-Allow-Headers': 'Content-Type, apikey, x-target-function, x-session-id',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
      ...extra,
    },
  });
}

// ── Direct DB session validation — no internal HTTP call ─────────────────────
// Checks admin_sessions table directly using the service role key.
// This avoids the server-to-server HTTP call to admin-auth that was
// going back through Supabase's gateway and causing 405 errors.
async function validateAdminSession(
  cookieHeader: string,
  sessionIdHeader: string,
): Promise<{ access_token: string; user_id: string; role: string } | null> {
  const sessionId =
    parseCookie(cookieHeader, SESSION_COOKIE) || sessionIdHeader || null;
  if (!sessionId) return null;

  const db = serviceClient();
  const { data: session, error } = await db
    .from('admin_sessions')
    .select('access_token, refresh_token, expires_at, user_id, role')
    .eq('session_id', sessionId)
    .single();

  if (error || !session) return null;

  // Reject expired sessions
  if (new Date(session.expires_at) < new Date()) {
    await db.from('admin_sessions').delete().eq('session_id', sessionId);
    return null;
  }

  // Enforce admin/superadmin role — never forward requests for regular users
  if (session.role !== 'admin' && session.role !== 'superadmin') {
    console.warn(`[admin-proxy] Non-admin role attempted access: ${session.role}`);
    return null;
  }

  // Proactively refresh the access token if within 5 minutes of JWT expiry
  let accessToken = session.access_token;
  try {
    const payload     = JSON.parse(atob(accessToken.split('.')[1]));
    const needsRefresh = payload.exp - Math.floor(Date.now() / 1000) < 300;

    if (needsRefresh) {
      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data: refreshData } = await anonClient.auth.refreshSession({
        refresh_token: session.refresh_token,
      });
      if (refreshData?.session) {
        const newExpiry = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
        await db.from('admin_sessions').update({
          access_token:  refreshData.session.access_token,
          refresh_token: refreshData.session.refresh_token,
          expires_at:    newExpiry,
          last_active:   new Date().toISOString(),
        }).eq('session_id', sessionId);
        accessToken = refreshData.session.access_token;
      }
    } else {
      // Touch last_active — fire and forget, don't block the response
      db.from('admin_sessions')
        .update({ last_active: new Date().toISOString() })
        .eq('session_id', sessionId)
        .then(() => {}).catch(() => {});
    }
  } catch {
    // Token decode failed — proceed with existing token
  }

  return {
    access_token: accessToken,
    user_id:      session.user_id,
    role:         session.role,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const origin = getAllowedOrigin(req);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':      origin,
        'Access-Control-Allow-Headers':     'Content-Type, apikey, x-target-function, x-session-id',
        'Access-Control-Allow-Methods':     'POST, OPTIONS',
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Origin',
      },
    });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, {}, req);
  }

  // ── 1. Identify target function from header ────────────────────────────────
  // Header-based routing is kept intentionally — script.js sends this header
  // directly via fetch() and cannot be changed without refactoring a non-module
  // script. The header is safe here because the proxy controls what it forwards.
  const targetFn = req.headers.get('x-target-function')?.trim();

  if (!targetFn) {
    return json({ error: 'Missing x-target-function header' }, 400, {}, req);
  }
  if (!ALLOWED_TARGETS.has(targetFn)) {
    console.warn(`[admin-proxy] Rejected unknown target: ${targetFn}`);
    logSecurityEvent({ severity: 'MEDIUM', event_type: 'unauthorized_endpoint_probe', action: targetFn, ip_address: getClientIp(req), details: { reason: 'unknown_target_function', target: targetFn }, source_function: 'admin-proxy' });
    return json({ error: `Unknown target function: ${targetFn}` }, 400, {}, req);
  }

  // ── 2. Validate admin session directly from DB ─────────────────────────────
  const cookieHeader    = req.headers.get('Cookie') ?? '';
  const sessionIdHeader = req.headers.get('x-session-id') ?? '';

  const sessionData = await validateAdminSession(cookieHeader, sessionIdHeader);

  if (!sessionData) {
    logSecurityEvent({ severity: 'HIGH', event_type: 'admin_session_invalid', action: targetFn, ip_address: getClientIp(req), details: { reason: 'missing_or_invalid_session', target: targetFn }, source_function: 'admin-proxy' });
    return json(
      { success: false, error: 'Session invalid or expired', requiresLogin: true },
      401,
      {},
      req,
    );
  }

  // ── 3. Parse request body ──────────────────────────────────────────────────
  let requestBody: unknown = {};
  try {
    requestBody = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, {}, req);
  }

  // ── 4. Forward to target function with injected bearer token ───────────────
  let targetRes: Response;
  try {
    // Forward with service role key — never expires, always valid.
    // Admin identity/role already verified above by validateAdminSession().
    // Target functions receive service role token + admin context headers.
    const cookieSessionId = parseCookie(req.headers.get('Cookie'), SESSION_COOKIE) || sessionIdHeader;
    targetRes = await fetch(`${FUNCTIONS_BASE}/${targetFn}`, {
      method: 'POST',
      headers: {
        'Content-Type':        'application/json',
        'Authorization':       `Bearer ${SERVICE_ROLE_KEY}`,
        'apikey':              SUPABASE_ANON_KEY,
        'x-admin-user-id':     sessionData.user_id,
        'x-admin-role':        sessionData.role,
        'x-session-id':        cookieSessionId ?? '',
        'x-internal-secret':   Deno.env.get('ADMIN_INTERNAL_SECRET') ?? '',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.error(`[admin-proxy] Failed to reach ${targetFn}:`, err);
    return json({ error: `Failed to reach ${targetFn}` }, 502, {}, req);
  }

  // ── 5. Return response to browser with CORS headers ───────────────────────
  const responseBody = await targetRes.text();
  return new Response(responseBody, {
    status: targetRes.status,
    headers: {
      'Content-Type': targetRes.headers.get('Content-Type') ?? 'application/json',
      'Access-Control-Allow-Origin':      origin,
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    },
  });
});