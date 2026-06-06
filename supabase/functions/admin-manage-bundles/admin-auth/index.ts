// ============================================================
// supabase/functions/admin-auth/index.ts  — Enterprise v1
// ============================================================
// CHANGES FROM Phase 2:
//   [1] access_token removed from verify response — JWT never
//       sent to browser. Admin proxy injects it server-side.
//   [2] Rate limiting added to login — 5 failed attempts →
//       15 min lockout. Uses same login_attempts table as
//       user-auth so the table already exists.
//   [3] Concurrent session limit — max 2 active admin sessions.
//       Oldest session evicted on new login beyond the limit.
//
// Deploy: supabase functions deploy admin-auth --no-verify-jwt
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';
import { crypto }       from 'https://deno.land/std@0.177.0/crypto/mod.ts';
import { logSecurityEvent, getClientIp } from '../_shared/security-logger.ts'; // FIX: removed duplicate import

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SESSION_COOKIE      = 'admin_sid';
const COOKIE_PATH         = '/';
const SESSION_TTL_SEC     = 8 * 60 * 60;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES     = 15;
const MAX_ADMIN_SESSIONS  = 2;   // admins get fewer concurrent sessions than users

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// FIX: removed local getClientIp — it shadowed the imported one from _shared/security-logger.ts
// getClientIp is now used solely from the shared import above.

function setCookie(sid: string, maxAge = SESSION_TTL_SEC): string {
  return [`${SESSION_COOKIE}=${sid}`, `Path=${COOKIE_PATH}`, `Max-Age=${maxAge}`,
          'HttpOnly', 'Secure', 'SameSite=None'].join('; ');
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

// ── Audit logger ──────────────────────────────────────────────────────────────
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

// ── [2] Rate limiting — reuses login_attempts table from user-auth ────────────
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

// ── Main handler ──────────────────────────────────────────────────────────────
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
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400, {}, req); }

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

    // [2] Rate limit check BEFORE hitting Supabase Auth
    const rateLimit = await checkRateLimit(db, email);
    if (rateLimit.locked) {
      auditLog(db, 'admin_login_blocked', null, ip, userAgent, { email });
      logSecurityEvent({ severity: 'HIGH', event_type: 'admin_login_blocked', account_email: email, action: 'login', ip_address: getClientIp(req), details: { reason: 'rate_limited', remaining_minutes: rateLimit.remainingMinutes }, source_function: 'admin-auth' });
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
      auditLog(db, 'admin_login_failed', null, ip, userAgent, { email, reason: authErr?.message });
      logSecurityEvent({ severity: 'HIGH', event_type: 'admin_login_failed', account_email: email, action: 'login', ip_address: getClientIp(req), details: { reason: authErr?.message ?? 'invalid_credentials' }, source_function: 'admin-auth' });

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
      .select('role, fullname, email')
      .eq('id', authData.session.user.id).single();

    if (profile?.role !== 'admin' && profile?.role !== 'superadmin') {
      await anonClient.auth.signOut();
      await recordAttempt(db, email, ip, false);
      auditLog(db, 'admin_login_denied', authData.session.user.id, ip, userAgent, {
        email, reason: 'insufficient role', role: profile?.role,
      });
      logSecurityEvent({ severity: 'HIGH', event_type: 'admin_access_denied', account_email: email, action: 'get_admin_profile', ip_address: getClientIp(req), details: { reason: 'not_admin', role: profile?.role ?? 'unknown' }, source_function: 'admin-auth' });
      return json({ success: false, error: 'Access denied: admin privileges required' }, 403, {}, req);
    }

    await recordAttempt(db, email, ip, true);

    // [3] Concurrent session limit — evict oldest if over limit
    const { data: existingSessions } = await db
      .from('admin_sessions').select('session_id, created_at')
      .eq('user_id', authData.session.user.id)
      .order('created_at', { ascending: true });

    if (existingSessions && existingSessions.length >= MAX_ADMIN_SESSIONS) {
      const toEvict = existingSessions.slice(0, existingSessions.length - MAX_ADMIN_SESSIONS + 1);
      await db.from('admin_sessions').delete()
        .in('session_id', toEvict.map(s => s.session_id));
    }

    const sessionId = await generateSessionId();
    const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();

    const { error: dbErr } = await db.from('admin_sessions').insert({
      session_id:    sessionId,
      user_id:       authData.session.user.id,
      access_token:  authData.session.access_token,
      refresh_token: authData.session.refresh_token,
      expires_at:    expiresAt,
      user_email:    authData.session.user.email,
      role:          profile.role,
      ip_address:    ip,
      user_agent:    userAgent,
      created_at:    new Date().toISOString(),
      last_active:   new Date().toISOString(),
    });

    if (dbErr) {
      console.error('Failed to create admin session:', dbErr);
      return json({ success: false, error: 'Session creation failed' }, 500, {}, req);
    }

    auditLog(db, 'admin_login_success', authData.session.user.id, ip, userAgent, {
      email, session_id: sessionId.slice(0, 8) + '…',
    });

    // ── 2FA: step 1 — send OTP ───────────────────────────────────────────────
    // step='request-otp' → send SMS OTP, return session_id (pending) + phone hint.
    // The session row is already in the DB. The client stores session_id in
    // sessionStorage and sends it as x-session-id in the verify-otp request.
    // step not set → no phone fallback — return session immediately (rare).
    const step        = (body.step as string) ?? '';
    const fingerprint = (body.fingerprint as string) ?? 'unknown';

    if (step === 'request-otp') {
      const ARKESEL_API_KEY = Deno.env.get('ARKESEL_API_KEY')!;
      const ARKESEL_SENDER  = Deno.env.get('ARKESEL_SENDER_ID') ?? 'PRIMECONNECT';

      const { data: userRow } = await db.from('users').select('phone').eq('id', authData.session.user.id).single();
      const phone = userRow?.phone ?? null;

      if (!phone) {
        // No phone on record — skip 2FA and return session immediately
        console.warn('[admin-auth] No phone for 2FA — granting session without OTP');
        return json(
          { success: true, session_id: sessionId,
            user: { fullname: profile.fullname, email: profile.email, role: profile.role } },
          200, { 'Set-Cookie': setCookie(sessionId) }, req,
        );
      }

      // Format phone for Arkesel (Ghana: 0XX → 233XX)
      let formattedPhone = phone.replace(/\D/g, '');
      if (formattedPhone.startsWith('0')) formattedPhone = '233' + formattedPhone.substring(1);
      if (!formattedPhone.startsWith('233')) formattedPhone = '233' + formattedPhone;

      const otpRes = await fetch('https://sms.arkesel.com/api/otp/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': ARKESEL_API_KEY },
        body: JSON.stringify({
          expiry:    5, length: 6, medium: 'sms', type: 'numeric',
          message:   'Your PrimeConnect admin OTP is %otp_code%. Expires in %expiry% minutes. Do not share.',
          number:    formattedPhone,
          sender_id: ARKESEL_SENDER,
        }),
      });
      const otpData = await otpRes.json() as Record<string, unknown>;

      if (otpData.code !== '1000') {
        console.error('[admin-auth] OTP send failed:', otpData);
        await db.from('admin_sessions').delete().eq('session_id', sessionId);
        return json({ success: false, error: 'Failed to send OTP. Please try again.' }, 500, {}, req);
      }

      logSecurityEvent({
        severity: 'LOW', event_type: 'admin_otp_sent', account_email: email,
        action: 'request_otp', ip_address: getClientIp(req),
        details: { fingerprint, phone_hint: phone.slice(-4) }, source_function: 'admin-auth',
      });

      // Return the pending session_id so the client can send it back in step 2.
      // Cookie is NOT set yet — session is pending OTP verification.
      const phoneHint = '*'.repeat(Math.max(0, phone.length - 4)) + phone.slice(-4);
      return json({ success: true, step: 'otp-sent', phone_hint: phoneHint, session_id: sessionId }, 200, {}, req);
    }

    // No step set — no-phone fallback or direct login: return session immediately
    return json(
      { success: true, session_id: sessionId,
        user: { fullname: profile.fullname, email: profile.email, role: profile.role } },
      200, { 'Set-Cookie': setCookie(sessionId) }, req,
    );
  }

  // ── VERIFY OTP ─────────────────────────────────────────────────────────────
  // Step 2 of 2FA. Client sends action:'verify-otp' + otp code.
  // session_id from step 1 arrives via x-session-id header (sessionStorage fallback)
  // or the Cookie header. We look up the pending session, verify the OTP with
  // Arkesel, then activate the session by setting the HttpOnly cookie.
  // No email or password is needed here — the session row proves step 1 passed.
  if (action === 'verify-otp') {
    const sessionId   = getSessionId();
    const otp         = (body.otp         as string) ?? '';
    const fingerprint = (body.fingerprint as string) ?? 'unknown';

    if (!sessionId) return json({ success: false, error: 'No pending session — please log in again.' }, 401, {}, req);
    if (!otp)       return json({ success: false, error: 'OTP code is required.' }, 400, {}, req);

    // Load the pending session
    const { data: pendingSession } = await db
      .from('admin_sessions')
      .select('user_id, role, user_email, access_token, refresh_token, expires_at')
      .eq('session_id', sessionId)
      .single();

    if (!pendingSession) {
      return json({ success: false, error: 'Session expired — please log in again.' }, 401, {}, req);
    }
    if (new Date(pendingSession.expires_at) < new Date()) {
      await db.from('admin_sessions').delete().eq('session_id', sessionId);
      return json({ success: false, error: 'Session expired — please log in again.' }, 401, {}, req);
    }

    // Get phone for verification
    const { data: userRow } = await db.from('users').select('phone, fullname, email').eq('id', pendingSession.user_id).single();
    const phone = userRow?.phone ?? null;

    if (phone) {
      let formattedPhone = phone.replace(/\D/g, '');
      if (formattedPhone.startsWith('0')) formattedPhone = '233' + formattedPhone.substring(1);
      if (!formattedPhone.startsWith('233')) formattedPhone = '233' + formattedPhone;

      const verifyRes = await fetch('https://sms.arkesel.com/api/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': Deno.env.get('ARKESEL_API_KEY')! },
        body: JSON.stringify({ code: otp, number: formattedPhone }),
      });
      const verifyData = await verifyRes.json() as Record<string, unknown>;

      if (verifyData.code !== '1100') {
        const reason = verifyData.code === '1105' ? 'OTP has expired. Please log in again.' :
                       verifyData.code === '1104' ? 'Invalid OTP code. Please try again.' :
                       'OTP verification failed. Please try again.';
        logSecurityEvent({
          severity: 'HIGH', event_type: 'admin_otp_failed',
          account_email: pendingSession.user_email, action: 'verify_otp',
          ip_address: getClientIp(req),
          details: { reason, arkesel_code: verifyData.code, fingerprint },
          source_function: 'admin-auth',
        });
        return json({ success: false, error: reason }, 401, {}, req);
      }
    }

    // OTP verified (or no phone) — activate session by setting the cookie
    await db.from('admin_sessions')
      .update({ last_active: new Date().toISOString() })
      .eq('session_id', sessionId);

    logSecurityEvent({
      severity: 'LOW', event_type: 'admin_login_success',
      account_email: pendingSession.user_email, action: 'login',
      ip_address: getClientIp(req),
      details: { fingerprint, role: pendingSession.role }, source_function: 'admin-auth',
    });

    return json(
      { success: true, session_id: sessionId,
        user: { fullname: userRow?.fullname, email: pendingSession.user_email, role: pendingSession.role } },
      200, { 'Set-Cookie': setCookie(sessionId) }, req,
    );
  }

  // ── REFRESH ────────────────────────────────────────────────────────────────
  if (action === 'refresh') {
    const sessionId = getSessionId();
    if (!sessionId) return json({ success: false, error: 'No session' }, 401, {}, req);

    const { data: session } = await db
      .from('admin_sessions').select('*').eq('session_id', sessionId).single();
    if (!session) return json({ success: false, error: 'Session not found' }, 401, {}, req);

    if (new Date(session.expires_at) < new Date()) {
      await db.from('admin_sessions').delete().eq('session_id', sessionId);
      return json({ success: false, error: 'Session expired' }, 401,
        { 'Set-Cookie': clearCookie() }, req);
    }

    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: refreshData, error: refreshErr } =
      await anonClient.auth.refreshSession({ refresh_token: session.refresh_token });

    if (refreshErr || !refreshData.session) {
      await db.from('admin_sessions').delete().eq('session_id', sessionId);
      return json({ success: false, error: 'Session expired — please log in again' },
        401, { 'Set-Cookie': clearCookie() }, req);
    }

    const newExpiry = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
    await db.from('admin_sessions').update({
      access_token:  refreshData.session.access_token,
      refresh_token: refreshData.session.refresh_token,
      expires_at:    newExpiry,
      last_active:   new Date().toISOString(),
    }).eq('session_id', sessionId);

    return json({ success: true }, 200, {}, req);
  }

  // ── LOGOUT ────────────────────────────────────────────────────────────────
  if (action === 'logout') {
    const sessionId = getSessionId();
    if (sessionId) {
      const { data: session } = await db
        .from('admin_sessions').select('access_token, user_id')
        .eq('session_id', sessionId).single();
      if (session?.access_token) {
        const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${session.access_token}` } },
        });
        await anonClient.auth.signOut().catch(() => {});
        auditLog(db, 'admin_logout', session.user_id, ip, userAgent);
      }
      await db.from('admin_sessions').delete().eq('session_id', sessionId);
    }
    return json({ success: true }, 200, { 'Set-Cookie': clearCookie() }, req);
  }

  // ── VERIFY ────────────────────────────────────────────────────────────────
  // [1] access_token is NO LONGER returned to the browser.
  //     admin-proxy injects it server-side from the DB.
  //     The browser only needs identity fields to render the UI.
  if (action === 'verify') {
    const sessionId = getSessionId();
    if (!sessionId) return json({ success: false, error: 'No session' }, 401, {}, req);

    const { data: session } = await db
      .from('admin_sessions').select('*').eq('session_id', sessionId).single();
    if (!session) return json({ success: false, error: 'Invalid session' }, 401, {}, req);

    if (new Date(session.expires_at) < new Date()) {
      await db.from('admin_sessions').delete().eq('session_id', sessionId);
      return json({ success: false, error: 'Session expired' }, 401,
        { 'Set-Cookie': clearCookie() }, req);
    }

    // Proactive token refresh — server-side only, never returned to browser
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
        await db.from('admin_sessions').update({
          access_token:  refreshData.session.access_token,
          refresh_token: refreshData.session.refresh_token,
          expires_at:    newExpiry,
          last_active:   new Date().toISOString(),
        }).eq('session_id', sessionId);
        // Token updated in DB only — never sent to browser
      }
    } else {
      await db.from('admin_sessions')
        .update({ last_active: new Date().toISOString() })
        .eq('session_id', sessionId);
    }

    // ── access_token intentionally omitted from this response ─────────────
    return json({
      success: true,
      // access_token: REMOVED — JWT never sent to browser
      user: {
        user_id: session.user_id,
        email:   session.user_email,
        role:    session.role,
      },
    }, 200, {}, req);
  }

  return json({ error: 'Unknown action' }, 400, {}, req);
});