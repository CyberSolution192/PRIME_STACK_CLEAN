// ============================================================
// supabase/functions/user-auth/index.ts  — Enterprise v3
// ============================================================
// CHANGE FROM v2:
//   [6] access_token removed from verify response — the JWT no
//       longer touches the browser at any point. The proxy
//       architecture injects it server-side; the frontend only
//       needs identity fields (user_id, user_email, etc.).
//
// All other logic identical to v2.
// Deploy with: supabase functions deploy user-auth --no-verify-jwt
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';
import { crypto }       from 'https://deno.land/std@0.177.0/crypto/mod.ts';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SESSION_COOKIE      = 'user_sid';
const COOKIE_PATH         = '/';
const SESSION_TTL_SEC     = 8 * 60 * 60;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES     = 15;
const MAX_SESSIONS        = 3;

const IS_PRODUCTION = Deno.env.get("ENVIRONMENT") === "production";

const ALLOWED_ORIGINS = new Set([
  "https://primeconnect.site",
  // Local dev origins — automatically excluded in production
  ...( IS_PRODUCTION ? [] : [
    "http://127.0.0.1:5500",
    "http://127.0.0.1:5501",
    "http://localhost:5500",
    "http://localhost:5501",
    "http://localhost:3000", 
  ]),
]);

function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function generateSessionId(): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('Origin') ?? '';
  return ALLOWED_ORIGINS.has(origin) ? origin : 'https://no-cors-for-you';
}

function getClientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    ?? req.headers.get('x-real-ip')
    ?? 'unknown';
}

function setCookie(sid: string, maxAge = SESSION_TTL_SEC): string {
  return [
    `${SESSION_COOKIE}=${sid}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
  ].join('; ');
}

function clearCookie(): string {
  return [`${SESSION_COOKIE}=`, `Path=${COOKIE_PATH}`, 'Max-Age=0',
          'HttpOnly', 'Secure', 'SameSite=None'].join('; ');
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
  body: unknown, status = 200,
  extra: Record<string, string> = {}, req?: Request,
): Response {
  const origin = req ? getAllowedOrigin(req) : 'https://no-cors-for-you';
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type, apikey, x-session-id',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
      ...extra,
    },
  });
}

function auditLog(
  db: ReturnType<typeof serviceClient>,
  action: string,
  userId: string | null,
  ip: string,
  userAgent: string,
  metadata: Record<string, unknown> = {},
): void {
  void (async () => {
    try {
      await db.from('audit_logs').insert({
        user_id: userId, action, ip_address: ip,
        user_agent: userAgent, metadata,
        created_at: new Date().toISOString(),
      });
    } catch (e) { console.error('[audit]', e); }
  })();
}

async function checkRateLimit(
  db: ReturnType<typeof serviceClient>,
  email: string,
): Promise<{ locked: boolean; remainingMinutes?: number }> {
  const windowStart = new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000).toISOString();
  const { count } = await db
    .from('login_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('email', email).eq('success', false).gte('attempted_at', windowStart);

  if ((count ?? 0) >= MAX_FAILED_ATTEMPTS) {
    const { data: oldest } = await db
      .from('login_attempts').select('attempted_at')
      .eq('email', email).eq('success', false).gte('attempted_at', windowStart)
      .order('attempted_at', { ascending: true }).limit(1).single();
    const unlockAt = oldest
      ? new Date(oldest.attempted_at).getTime() + LOCKOUT_MINUTES * 60 * 1000
      : Date.now();
    return { locked: true, remainingMinutes: Math.max(1, Math.ceil((unlockAt - Date.now()) / 60000)) };
  }
  return { locked: false };
}

async function recordAttempt(
  db: ReturnType<typeof serviceClient>,
  email: string, ip: string, success: boolean,
): Promise<void> {
  await db.from('login_attempts').insert({
    email, ip_address: ip, success, attempted_at: new Date().toISOString(),
  });
  db.from('login_attempts')
    .delete()
    .lt('attempted_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .then(() => {}).catch(() => {});
}

serve(async (req: Request) => {
  const origin = getAllowedOrigin(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin':      origin,
      'Access-Control-Allow-Headers':     'Content-Type, apikey, x-session-id',
      'Access-Control-Allow-Methods':     'POST, OPTIONS',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    }});
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, {}, req);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, {}, req); }

  const { action } = body;
  const db         = serviceClient();
  const ip         = getClientIp(req);
  const userAgent  = req.headers.get('user-agent') ?? 'unknown';

  const getSessionId = () =>
    parseCookie(req.headers.get('Cookie'), SESSION_COOKIE) ||
    (body.__sid as string | undefined) ||
    req.headers.get('x-session-id');

  // ── LOGIN ──────────────────────────────────────────────────────────────────
  if (action === 'login') {
    const email    = (body.email    as string | undefined)?.toLowerCase().trim() ?? '';
    const password = (body.password as string | undefined) ?? '';

    if (!email || !password)
      return json({ success: false, error: 'Credentials required' }, 400, {}, req);

    const rateLimit = await checkRateLimit(db, email);
    if (rateLimit.locked) {
      auditLog(db, 'login_blocked_rate_limit', null, ip, userAgent, { email });
      return json({
        success: false,
        error: `Account temporarily locked. Try again in ${rateLimit.remainingMinutes} minute(s).`,
        locked: true,
      }, 429, {}, req);
    }

    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: authData, error: authErr } =
      await anonClient.auth.signInWithPassword({ email, password });

    if (authErr || !authData.session) {
      await recordAttempt(db, email, ip, false);
      auditLog(db, 'login_failed', null, ip, userAgent, { email, reason: authErr?.message });
      const { count: failCount } = await db
        .from('login_attempts').select('*', { count: 'exact', head: true })
        .eq('email', email).eq('success', false)
        .gte('attempted_at', new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000).toISOString());
      const remaining = MAX_FAILED_ATTEMPTS - (failCount ?? 0);
      const msg = remaining <= 2
        ? `Invalid credentials. ${remaining} attempt(s) left before lockout.`
        : 'Invalid email or password.';
      return json({ success: false, error: msg }, 401, {}, req);
    }

    const { data: profile } = await db
      .from('users')
      .select('role, fullname, email, phone, store_unlocked, transaction_pin_hash')
      .eq('id', authData.session.user.id).single();

    if (profile?.role === 'admin' || profile?.role === 'superadmin') {
      await anonClient.auth.signOut();
      return json({ success: false, error: 'Please use the admin portal to sign in.' }, 403, {}, req);
    }

    await recordAttempt(db, email, ip, true);

    const { data: existingSessions } = await db
      .from('user_sessions').select('session_id, created_at')
      .eq('user_id', authData.session.user.id)
      .order('created_at', { ascending: true });

    if (existingSessions && existingSessions.length >= MAX_SESSIONS) {
      const toEvict = existingSessions.slice(0, existingSessions.length - MAX_SESSIONS + 1);
      await db.from('user_sessions').delete()
        .in('session_id', toEvict.map(s => s.session_id));
    }

    const sessionId = await generateSessionId();
    const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();

    const { error: dbErr } = await db.from('user_sessions').insert({
      session_id:    sessionId,
      user_id:       authData.session.user.id,
      access_token:  authData.session.access_token,
      refresh_token: authData.session.refresh_token,
      expires_at:    expiresAt,
      user_email:    authData.session.user.email,
      ip_address:    ip,
      user_agent:    userAgent,
      login_at:      new Date().toISOString(),
      created_at:    new Date().toISOString(),
      last_active:   new Date().toISOString(),
    });

    if (dbErr) {
      console.error('Session insert failed:', dbErr);
      return json({ success: false, error: 'Session creation failed' }, 500, {}, req);
    }

    auditLog(db, 'login_success', authData.session.user.id, ip, userAgent, {
      email, session_id: sessionId.slice(0, 8) + '…',
    });

    return json({
      success:    true,
      session_id: sessionId,
      user: {
        id:             authData.session.user.id,
        email:          profile?.email ?? authData.session.user.email,
        fullname:       profile?.fullname,
        role:           profile?.role,
        store_unlocked: profile?.store_unlocked ?? false,
        pin_set:        !!profile?.transaction_pin_hash,
      },
    }, 200, { 'Set-Cookie': setCookie(sessionId) }, req);
  }

  // ── LOGOUT ─────────────────────────────────────────────────────────────────
  if (action === 'logout') {
    const sessionId = getSessionId();
    if (sessionId) {
      const { data: session } = await db
        .from('user_sessions').select('access_token, user_id')
        .eq('session_id', sessionId).single();
      if (session?.access_token) {
        const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${session.access_token}` } },
        });
        await anonClient.auth.signOut().catch(() => {});
        auditLog(db, 'logout', session.user_id, ip, userAgent);
      }
      await db.from('user_sessions').delete().eq('session_id', sessionId);
    }
    return json({ success: true }, 200, { 'Set-Cookie': clearCookie() }, req);
  }

  // ── REFRESH ────────────────────────────────────────────────────────────────
  if (action === 'refresh') {
    const sessionId = getSessionId();
    if (!sessionId) return json({ success: false, error: 'No session' }, 401, {}, req);

    const { data: session } = await db
      .from('user_sessions').select('*').eq('session_id', sessionId).single();
    if (!session) return json({ success: false, error: 'Session not found' }, 401, {}, req);

    if (new Date(session.expires_at) < new Date()) {
      await db.from('user_sessions').delete().eq('session_id', sessionId);
      auditLog(db, 'session_expired', session.user_id, ip, userAgent);
      return json({ success: false, error: 'Session expired' }, 401,
        { 'Set-Cookie': clearCookie() }, req);
    }

    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: refreshData, error: refreshErr } =
      await anonClient.auth.refreshSession({ refresh_token: session.refresh_token });

    if (refreshErr || !refreshData.session) {
      await db.from('user_sessions').delete().eq('session_id', sessionId);
      return json({ success: false, error: 'Session expired — please log in again' },
        401, { 'Set-Cookie': clearCookie() }, req);
    }

    const newExpiry = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
    await db.from('user_sessions').update({
      access_token:  refreshData.session.access_token,
      refresh_token: refreshData.session.refresh_token,
      expires_at:    newExpiry,
      last_active:   new Date().toISOString(),
    }).eq('session_id', sessionId);

    return json({ success: true }, 200, {}, req);
  }

  // ── VERIFY ─────────────────────────────────────────────────────────────────
  // [6] access_token is NO LONGER returned to the browser.
  //     The proxy injects it server-side. The frontend only needs
  //     identity fields to render the UI and route requests.
  if (action === 'verify') {
    const sessionId = getSessionId();
    if (!sessionId) return json({ success: false, error: 'No session' }, 401, {}, req);

    const { data: session } = await db
      .from('user_sessions').select('*').eq('session_id', sessionId).single();
    if (!session) return json({ success: false, error: 'Invalid session' }, 401, {}, req);

    if (new Date(session.expires_at) < new Date()) {
      await db.from('user_sessions').delete().eq('session_id', sessionId);
      auditLog(db, 'session_expired', session.user_id, ip, userAgent);
      return json({ success: false, error: 'Session expired' }, 401,
        { 'Set-Cookie': clearCookie() }, req);
    }

    // Proactive token refresh — kept server-side only, never sent to browser
    let needsRefresh = false;
    try {
      const payload = JSON.parse(atob(session.access_token.split('.')[1]));
      needsRefresh  = payload.exp - Math.floor(Date.now() / 1000) < 300;
    } catch { needsRefresh = true; }

    if (needsRefresh) {
      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data: refreshData } =
        await anonClient.auth.refreshSession({ refresh_token: session.refresh_token });
      if (refreshData?.session) {
        const newExpiry = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
        await db.from('user_sessions').update({
          access_token:  refreshData.session.access_token,
          refresh_token: refreshData.session.refresh_token,
          expires_at:    newExpiry,
          last_active:   new Date().toISOString(),
        }).eq('session_id', sessionId);
        // Note: updated token stays in DB only — never assigned to a variable
        // that could leak into the response body below
      }
    } else {
      db.from('user_sessions')
        .update({ last_active: new Date().toISOString() })
        .eq('session_id', sessionId)
        .then(() => {}).catch(() => {});
    }

    const { data: verifyProfile } = await db
      .from('users')
      .select('fullname, store_unlocked, transaction_pin_hash')
      .eq('id', session.user_id).single();

    // ── access_token intentionally omitted from this response ─────────────
    return json({
      success:        true,
      // access_token: REMOVED — JWT never sent to browser
      user_id:        session.user_id,
      user_email:     session.user_email,
      store_unlocked: verifyProfile?.store_unlocked ?? false,
      pin_set:        !!verifyProfile?.transaction_pin_hash,
      fullname:       verifyProfile?.fullname ?? null,
    }, 200, {}, req);
  }

  return json({ error: 'Unknown action' }, 400, {}, req);
});